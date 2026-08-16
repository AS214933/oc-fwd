package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDNSCacheCachesHits(t *testing.T) {
	var calls atomic.Int64
	c := newDNSCache(time.Hour, func(ctx context.Context, host string) ([]net.IP, error) {
		calls.Add(1)
		return []net.IP{net.ParseIP("2001:db8::1"), net.ParseIP("203.0.113.7")}, nil
	})
	for i := 0; i < 20; i++ {
		ips, err := c.lookup(context.Background(), "example.com")
		if err != nil {
			t.Fatalf("lookup %d: %v", i, err)
		}
		if len(ips) != 2 {
			t.Fatalf("lookup %d: got %d ips", i, len(ips))
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("resolver called %d times, want 1 (cached)", got)
	}
}

func TestDNSCacheExpiresAfterTTL(t *testing.T) {
	var calls atomic.Int64
	c := newDNSCache(30*time.Millisecond, func(ctx context.Context, host string) ([]net.IP, error) {
		calls.Add(1)
		return []net.IP{net.ParseIP("203.0.113.1")}, nil
	})
	if _, err := c.lookup(context.Background(), "example.com"); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, err := c.lookup(context.Background(), "example.com"); err != nil {
		t.Fatalf("lookup after ttl: %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("resolver called %d times, want 2 (ttl expired)", got)
	}
}

func TestDNSCacheCachesFailuresShortly(t *testing.T) {
	var calls atomic.Int64
	c := newDNSCache(time.Hour, func(ctx context.Context, host string) ([]net.IP, error) {
		calls.Add(1)
		return nil, errors.New("no such host")
	})
	for i := 0; i < 5; i++ {
		if _, err := c.lookup(context.Background(), "dead.example"); err == nil {
			t.Fatalf("lookup %d: expected error", i)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("resolver called %d times, want 1 (negative cache)", got)
	}
}

func TestDNSCacheSingleFlight(t *testing.T) {
	start := make(chan struct{})
	var calls atomic.Int64
	c := newDNSCache(time.Hour, func(ctx context.Context, host string) ([]net.IP, error) {
		calls.Add(1)
		<-start // hold the in-flight resolution until all callers arrived
		return []net.IP{net.ParseIP("203.0.113.9")}, nil
	})
	const n = 16
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = c.lookup(context.Background(), "example.com")
		}(i)
	}
	// Give all goroutines a chance to hit the pending entry, then release.
	time.Sleep(50 * time.Millisecond)
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("lookup %d: %v", i, err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("resolver called %d times for %d concurrent lookups, want 1", got, n)
	}
}

func TestDNSCacheHonorsContextWhileWaiting(t *testing.T) {
	start := make(chan struct{})
	c := newDNSCache(time.Hour, func(ctx context.Context, host string) ([]net.IP, error) {
		<-start
		return []net.IP{net.ParseIP("203.0.113.9")}, nil
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.lookup(context.Background(), "example.com")
	}()
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.lookup(ctx, "example.com"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting caller should be bounded by its ctx, got %v", err)
	}
	close(start)
	<-done
}

// discardListener accepts TCP connections and then never speaks, to exercise
// dial timeouts and handshake deadlines.
type discardListener struct {
	ln   net.Listener
	conn atomic.Int64
}

func newDiscardListener(t *testing.T) *discardListener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d := &discardListener{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			d.conn.Add(1)
			// Keep the connection open but never respond.
			go func(conn net.Conn) {
				io.Copy(io.Discard, conn)
				conn.Close()
			}(c)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return d
}

func TestSocks5DialTimesOutWhenProxySilent(t *testing.T) {
	disc := newDiscardListener(t)
	d, err := newSocks5Dialer("socks5://"+disc.ln.Addr().String(), 100*time.Millisecond)
	if err != nil {
		t.Fatalf("dialer: %v", err)
	}
	start := time.Now()
	_, err = d.Dial("tcp", "example.com:443")
	if err == nil {
		t.Fatal("expected handshake timeout against a silent socks5 proxy")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("dial took %v, want it bounded by the 100ms timeout", d)
	}
}

func TestSocks5DialHonorsContext(t *testing.T) {
	disc := newDiscardListener(t)
	d, err := newSocks5Dialer("socks5://"+disc.ln.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatalf("dialer: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = d.DialContext(ctx, "tcp", "example.com:443")
	if err == nil {
		t.Fatal("expected handshake to abort when the context expires")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("dial took %v, want it bounded by the 100ms context", d)
	}
}

// authSocks5Server validates username/password authentication and proxies to
// the requested target, so the pipelined handshake is exercised end to end.
type authSocks5Server struct {
	ln       net.Listener
	user     string
	pass     string
	authSeen atomic.Bool
}

func newAuthSocks5Server(t *testing.T, user, pass string) *authSocks5Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &authSocks5Server{ln: ln, user: user, pass: pass}
	go s.serve()
	t.Cleanup(func() { ln.Close() })
	return s
}

func (s *authSocks5Server) addr() string { return s.ln.Addr().String() }

func (s *authSocks5Server) serve() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(c)
	}
}

func (s *authSocks5Server) handle(c net.Conn) {
	defer c.Close()
	greet := make([]byte, 2)
	if _, err := io.ReadFull(c, greet); err != nil || greet[0] != 0x05 || greet[1] != 1 {
		return
	}
	methods := make([]byte, int(greet[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	if methods[0] != 0x02 {
		return
	}
	if _, err := c.Write([]byte{0x05, 0x02}); err != nil { // user/pass only
		return
	}
	auth := make([]byte, 2)
	if _, err := io.ReadFull(c, auth); err != nil || auth[0] != 0x01 {
		return
	}
	user := make([]byte, int(auth[1]))
	if _, err := io.ReadFull(c, user); err != nil {
		return
	}
	plen := make([]byte, 1)
	if _, err := io.ReadFull(c, plen); err != nil {
		return
	}
	pass := make([]byte, int(plen[0]))
	if _, err := io.ReadFull(c, pass); err != nil {
		return
	}
	if string(user) != s.user || string(pass) != s.pass {
		c.Write([]byte{0x01, 0x01})
		return
	}
	s.authSeen.Store(true)
	c.Write([]byte{0x01, 0x00})

	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil || head[0] != 0x05 || head[1] != 0x01 {
		return
	}
	var host string
	switch head[3] {
	case 0x01:
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return
		}
		b := make([]byte, int(l[0]))
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = string(b)
	default:
		return
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(c, port); err != nil {
		return
	}
	target, err := net.Dial("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", uint16(port[0])<<8|uint16(port[1]))))
	if err != nil {
		c.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer target.Close()
	c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	done := make(chan struct{}, 2)
	go func() { io.Copy(target, c); done <- struct{}{} }()
	go func() { io.Copy(c, target); done <- struct{}{} }()
	<-done
}

func TestSocks5DialWithAuthPipelined(t *testing.T) {
	// An upstream TCP echo/roundtrip target behind the socks5 proxy.
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		c, err := upstream.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(c, buf); err != nil {
			return
		}
		c.Write([]byte("pong"))
	}()

	socks := newAuthSocks5Server(t, "alice", "s3cret")
	d, err := newSocks5Dialer("socks5://alice:s3cret@"+socks.addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dialer: %v", err)
	}
	conn, err := d.Dial("tcp", upstream.Addr().String())
	if err != nil {
		t.Fatalf("dial through authenticated socks5: %v", err)
	}
	defer conn.Close()
	if !socks.authSeen.Load() {
		t.Fatal("socks5 server never received valid credentials")
	}
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "pong" {
		t.Fatalf("got %q, want pong", buf)
	}
}

func TestSocks5DialWrongCredentials(t *testing.T) {
	socks := newAuthSocks5Server(t, "alice", "s3cret")
	d, err := newSocks5Dialer("socks5://alice:wrong@"+socks.addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dialer: %v", err)
	}
	if _, err := d.Dial("tcp", "example.com:443"); err == nil {
		t.Fatal("expected auth failure with wrong credentials")
	}
}

func TestTLSClientSessionCacheEnabled(t *testing.T) {
	cfg := baseCfg()
	p := newTestProxy(t, cfg)
	tr, ok := p.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type %T", p.client.Transport)
	}
	if tr.TLSClientConfig == nil || tr.TLSClientConfig.ClientSessionCache == nil {
		t.Fatal("expected TLS client session cache to be enabled")
	}
}
