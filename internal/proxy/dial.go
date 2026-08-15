package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/proxy"

	"zenproxy/internal/config"
)

// makeDialContext wraps a base dialer with optional IPv6-first preference:
// the hostname is resolved locally, IPv6 addresses are tried before IPv4,
// falling back to the other family on failure. When disabled the base dialer
// is used as-is (hostname passthrough for socks5h).
func makeDialContext(cfg config.Config, log *slog.Logger, base func(ctx context.Context, network, address string) (net.Conn, error)) func(ctx context.Context, network, address string) (net.Conn, error) {
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
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
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

func newSocks5Dialer(s string) (proxy.Dialer, error) {
	u, err := url.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("invalid ZEN_SOCKS5: %w", err)
	}
	if u.Scheme != "socks5" && u.Scheme != "socks5h" {
		return nil, fmt.Errorf("invalid ZEN_SOCKS5 scheme %q (want socks5://)", u.Scheme)
	}
	var auth *proxy.Auth
	if u.User != nil {
		auth = &proxy.Auth{User: u.User.Username()}
		auth.Password, _ = u.User.Password()
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "1080")
	}
	return proxy.SOCKS5("tcp", host, auth, proxy.Direct)
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
		d, err := newSocks5Dialer(p.cfg.Socks5)
		if err != nil {
			return nil, "", err
		}
		base = func(ctx context.Context, network, address string) (net.Conn, error) {
			return d.Dial(network, address)
		}
	} else {
		nd := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		base = nd.DialContext
	}

	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
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
