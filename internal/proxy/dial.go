package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"zenproxy/internal/config"
)

const (
	socks5DialDefault = 15 * time.Second
)

// dnsCache memoizes hostname lookups for a short TTL. The ipv6-prefer dial
// path resolves the upstream hostname locally on every connection; at high
// concurrency that becomes a stampede of identical system DNS queries on the
// hot path. Resolving once per TTL (with single-flight coalescing) removes
// that work from every request while keeping the exit IP behavior unchanged.
type dnsCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	negTTL  time.Duration
	entries map[string]dnsEntry
	pending map[string]*dnsCall
	resolve func(ctx context.Context, host string) ([]net.IP, error)
}

type dnsEntry struct {
	ips []net.IP
	err error
	at  time.Time
	ttl time.Duration
}

type dnsCall struct {
	done chan struct{}
	ips  []net.IP
	err  error
}

func newDNSCache(ttl time.Duration, resolve func(ctx context.Context, host string) ([]net.IP, error)) *dnsCache {
	if ttl <= 0 {
		return nil
	}
	if resolve == nil {
		resolve = func(ctx context.Context, host string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip", host)
		}
	}
	return &dnsCache{
		ttl:     ttl,
		negTTL:  5 * time.Second,
		entries: map[string]dnsEntry{},
		pending: map[string]*dnsCall{},
		resolve: resolve,
	}
}

// lookup returns the cached address list for host, resolving it on a miss.
// Concurrent lookups for the same host share a single in-flight resolution.
func (c *dnsCache) lookup(ctx context.Context, host string) ([]net.IP, error) {
	if c == nil {
		return net.DefaultResolver.LookupIP(ctx, "ip", host)
	}
	c.mu.Lock()
	if e, ok := c.entries[host]; ok && time.Since(e.at) < e.ttl {
		c.mu.Unlock()
		return e.ips, e.err
	}
	if call, ok := c.pending[host]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.ips, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &dnsCall{done: make(chan struct{})}
	c.pending[host] = call
	c.mu.Unlock()

	ips, err := c.resolve(ctx, host)

	c.mu.Lock()
	delete(c.pending, host)
	ttl := c.negTTL
	if err == nil {
		ttl = c.ttl
	}
	c.entries[host] = dnsEntry{ips: ips, err: err, at: time.Now(), ttl: ttl}
	call.ips, call.err = ips, err
	close(call.done)
	c.mu.Unlock()
	return ips, err
}

// makeDialContext wraps a base dialer with optional IPv6-first preference:
// the hostname is resolved locally (through an optional TTL cache), IPv6
// addresses are tried before IPv4, falling back to the other family on
// failure. When disabled the base dialer is used as-is (hostname passthrough
// for socks5h).
func makeDialContext(cfg config.Config, log *slog.Logger, base func(ctx context.Context, network, address string) (net.Conn, error), cache ...*dnsCache) func(ctx context.Context, network, address string) (net.Conn, error) {
	var dc *dnsCache
	if len(cache) > 0 {
		dc = cache[0]
	}
	if !cfg.IPv6Prefer && !cfg.ForceIPv6 {
		return base
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return base(ctx, network, address)
		}
		if net.ParseIP(host) != nil {
			// explicit IP literal: force mode rejects v4 targets
			if cfg.ForceIPv6 && net.ParseIP(host).To4() != nil {
				return nil, fmt.Errorf("ipv6 forced but target %s is ipv4", host)
			}
			return base(ctx, network, address)
		}
		ips, err := dc.lookup(ctx, host)
		if err != nil || len(ips) == 0 {
			log.Debug("dns lookup failed, using hostname as-is", "host", host, "error", err)
			if cfg.ForceIPv6 {
				return nil, fmt.Errorf("ipv6 forced but dns failed for %s: %w", host, err)
			}
			return base(ctx, network, address)
		}
		for _, ip := range orderIPs(ips, true) {
			if cfg.ForceIPv6 && ip.To4() != nil {
				continue // v6 only
			}
			addr := net.JoinHostPort(ip.String(), port)
			conn, err := base(ctx, network, addr)
			if err == nil {
				log.Debug("dialed upstream", "host", host, "ip", ip.String(), "via", addr, "family", ipFamily(ip))
				return conn, nil
			}
			if cfg.ForceIPv6 {
				log.Warn("ipv6 dial failed (no ipv4 fallback in force mode)", "host", host, "ip", ip.String(), "error", err)
				return nil, fmt.Errorf("ipv6 dial failed for %s (%s): %w", host, ip.String(), err)
			}
		}
		if cfg.ForceIPv6 {
			return nil, fmt.Errorf("ipv6 forced but no ipv6 address found for %s", host)
		}
		return nil, fmt.Errorf("no usable address for %s", host)
	}
}

// socks5Dialer is a context- and timeout-aware SOCKS5 dialer that writes the
// whole handshake (greeting, optional auth, CONNECT) in a single packet so a
// fresh connection costs fewer round trips. Each call still opens a brand-new
// TCP connection to the SOCKS5 server - nothing is pooled or reused - which is
// exactly what the exit-IP rotation relies on.
type socks5Dialer struct {
	proxyAddr  string
	user, pass string
	timeout    time.Duration
}

func newSocks5Dialer(s string, opts ...time.Duration) (*socks5Dialer, error) {
	u, err := url.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("invalid ZEN_SOCKS5: %w", err)
	}
	if u.Scheme != "socks5" && u.Scheme != "socks5h" {
		return nil, fmt.Errorf("invalid ZEN_SOCKS5 scheme %q (want socks5://)", u.Scheme)
	}
	hasAuth := false
	var user, pass string
	if u.User != nil {
		hasAuth = true
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "1080")
	}
	timeout := socks5DialDefault
	if len(opts) > 0 && opts[0] > 0 {
		timeout = opts[0]
	}
	d := &socks5Dialer{proxyAddr: host, timeout: timeout}
	if hasAuth {
		d.user, d.pass = user, pass
	}
	return d, nil
}

// Dial opens a fresh connection without a context; DialContext is preferred.
func (d *socks5Dialer) Dial(network, address string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, address)
}

// DialContext opens a fresh TCP connection to the SOCKS5 server and runs the
// handshake, bounded by the dial timeout and the caller's context. It fails
// fast instead of letting requests pile up on an unresponsive proxy.
func (d *socks5Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	nd := &net.Dialer{Timeout: d.timeout}
	conn, err := nd.DialContext(ctx, "tcp", d.proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("socks5: connect to %s: %w", d.proxyAddr, err)
	}
	deadline := time.Now().Add(d.timeout)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	if err := conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return nil, err
	}
	if err := d.handshake(conn, address); err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return conn, nil
}

// handshake performs the SOCKS5 negotiation. The greeting, auth sub-negotiation
// and CONNECT request are emitted as one write; the replies are then read back
// in order. Servers process them out of the socket buffer, so no round trips
// are lost waiting for each intermediate reply.
func (d *socks5Dialer) handshake(conn net.Conn, target string) error {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return fmt.Errorf("socks5: invalid target %q: %w", target, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 0 || port > 65535 {
		return fmt.Errorf("socks5: invalid target port %q", portStr)
	}

	var atyp byte
	var addr []byte
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			atyp, addr = 0x01, v4
		} else {
			atyp, addr = 0x04, ip.To16()
		}
	} else {
		if len(host) > 255 {
			return fmt.Errorf("socks5: target hostname too long")
		}
		atyp = 0x03
		addr = append([]byte{byte(len(host))}, host...)
	}

	method := byte(0x00)
	buf := []byte{0x05, 0x01, method}
	if d.pass != "" || d.user != "" {
		method = 0x02
		buf = []byte{0x05, 0x01, method}
		buf = append(buf, 0x01, byte(len(d.user)))
		buf = append(buf, d.user...)
		buf = append(buf, byte(len(d.pass)))
		buf = append(buf, d.pass...)
	}
	buf = append(buf, 0x05, 0x01, 0x00, atyp)
	buf = append(buf, addr...)
	buf = append(buf, byte(port>>8), byte(port))
	if _, err := conn.Write(buf); err != nil {
		return fmt.Errorf("socks5: write handshake: %w", err)
	}

	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return fmt.Errorf("socks5: read method reply: %w", err)
	}
	if reply[0] != 0x05 {
		return fmt.Errorf("socks5: bad version %d in method reply", reply[0])
	}
	if reply[1] == 0xff {
		return fmt.Errorf("socks5: no acceptable authentication method")
	}
	if method == 0x02 {
		if reply[1] != 0x02 {
			return fmt.Errorf("socks5: server selected method %d, want username/password", reply[1])
		}
		authReply := make([]byte, 2)
		if _, err := io.ReadFull(conn, authReply); err != nil {
			return fmt.Errorf("socks5: read auth reply: %w", err)
		}
		if authReply[0] != 0x01 || authReply[1] != 0x00 {
			return fmt.Errorf("socks5: username/password auth failed (status %d)", authReply[1])
		}
	}

	var connectReply [4]byte
	if _, err := io.ReadFull(conn, connectReply[:]); err != nil {
		return fmt.Errorf("socks5: read connect reply: %w", err)
	}
	if connectReply[0] != 0x05 {
		return fmt.Errorf("socks5: bad version %d in connect reply", connectReply[0])
	}
	if connectReply[1] != 0x00 {
		return fmt.Errorf("socks5: connect to %s: %s", target, socks5Status(connectReply[1]))
	}
	// Drain the bound address + port the server echoes back.
	switch connectReply[3] {
	case 0x01:
		_, err = io.CopyN(io.Discard, conn, 4)
	case 0x04:
		_, err = io.CopyN(io.Discard, conn, 16)
	case 0x03:
		var l [1]byte
		if _, err = io.ReadFull(conn, l[:]); err == nil {
			_, err = io.CopyN(io.Discard, conn, int64(l[0]))
		}
	default:
		err = fmt.Errorf("socks5: bad bind address type %d", connectReply[3])
	}
	if err != nil {
		return fmt.Errorf("socks5: read bind address: %w", err)
	}
	if _, err := io.CopyN(io.Discard, conn, 2); err != nil {
		return fmt.Errorf("socks5: read bind port: %w", err)
	}
	return nil
}

func socks5Status(code byte) string {
	switch code {
	case 0x01:
		return "general failure"
	case 0x02:
		return "connection not allowed"
	case 0x03:
		return "network unreachable"
	case 0x04:
		return "host unreachable"
	case 0x05:
		return "connection refused"
	case 0x06:
		return "TTL expired"
	case 0x07:
		return "command not supported"
	case 0x08:
		return "address type not supported"
	default:
		return fmt.Sprintf("unknown error 0x%02x", code)
	}
}

// orderIPs sorts addresses so the preferred family comes first.
func orderIPs(ips []net.IP, prefer6 bool) []net.IP {
	var v6, v4 []net.IP
	for _, ip := range ips {
		if ip.To4() == nil {
			v6 = append(v6, ip)
		} else {
			v4 = append(v4, ip)
		}
	}
	if prefer6 {
		return append(v6, v4...)
	}
	return append(v4, v6...)
}

// handleDebugUpstreamIP reports which IP family/address the proxy would use
// to reach the upstream (through the same socks5 + ipv6-prefer dial path).
func (p *Proxy) handleDebugUpstreamIP(w http.ResponseWriter, r *http.Request) {
	ip, family, err := p.probeUpstreamIP(r.Context())
	payload := map[string]any{
		"upstream":    p.cfg.UpstreamBase,
		"socks5":      p.cfg.Socks5 != "",
		"ipv6_prefer": p.cfg.IPv6Prefer,
		"ipv6_force":  p.cfg.ForceIPv6,
	}
	if err != nil {
		payload["error"] = err.Error()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(payload)
		return
	}
	payload["ip"] = ip.String()
	payload["family"] = family
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

func (p *Proxy) probeUpstreamIP(ctx context.Context) (net.IP, string, error) {
	u, err := url.Parse(p.cfg.UpstreamBase)
	if err != nil || u.Hostname() == "" {
		return nil, "", fmt.Errorf("invalid upstream: %s", p.cfg.UpstreamBase)
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "443"
	}

	var base func(ctx context.Context, network, address string) (net.Conn, error)
	if p.cfg.Socks5 != "" {
		timeout := p.cfg.DialTimeout
		if timeout <= 0 {
			timeout = socks5DialDefault
		}
		d, err := newSocks5Dialer(p.cfg.Socks5, timeout)
		if err != nil {
			return nil, "", err
		}
		base = d.DialContext
	} else {
		timeout := p.cfg.DialTimeout
		if timeout <= 0 {
			timeout = socks5DialDefault
		}
		nd := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
		base = nd.DialContext
	}

	ips, err := p.dns.lookup(ctx, host)
	if err != nil {
		return nil, "", err
	}
	var lastErr error
	for _, ip := range orderIPs(ips, true) {
		if p.cfg.ForceIPv6 && ip.To4() != nil {
			continue
		}
		conn, err := base(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		if err == nil {
			conn.Close()
			return ip, ipFamily(ip), nil
		}
		lastErr = err
		if p.cfg.ForceIPv6 {
			break
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no usable %s address for %s", func() string {
			if p.cfg.ForceIPv6 {
				return "ipv6"
			}
			return "ip"
		}(), host)
	}
	return nil, "", lastErr
}

func ipFamily(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	if ip.To4() != nil {
		return "ipv4"
	}
	return "ipv6"
}
