package circuit

import (
	"sync"
	"time"
)

// Circuit shields the upstream from 429 storms: after threshold consecutive
// upstream 429s it opens and rejects requests without contacting the upstream
// until the cooldown elapses.
type Circuit struct {
	mu        sync.Mutex
	failures  int
	openedAt  time.Time
	threshold int
	cooldown  time.Duration
}

func New(failures int, cooldown time.Duration) *Circuit {
	return &Circuit{threshold: failures, cooldown: cooldown}
}

// Allow reports whether the upstream may be contacted now.
func (c *Circuit) Allow() bool {
	if c.threshold <= 0 {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failures >= c.threshold {
		if time.Since(c.openedAt) >= c.cooldown {
			c.failures = 0 // half-open: let one request through
			return true
		}
		return false
	}
	return true
}

func (c *Circuit) RecordFailure() {
	if c.threshold <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures++
	if c.failures >= c.threshold {
		c.openedAt = time.Now()
	}
}

func (c *Circuit) RecordSuccess() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures = 0
}
