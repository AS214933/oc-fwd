package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeKeysFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "keys.txt")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadKeysFromFile(t *testing.T) {
	path := writeKeysFile(t, "key-A\n\n# comment\n  key-B  \r\nkey-C\n")
	t.Setenv("ZEN_API_KEYS_FILE", path)
	t.Setenv("ZEN_NO_KEY_FAIL_THRESHOLD", "5")
	t.Setenv("ZEN_NO_KEY_PROBE_SECONDS", "2")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := []string{"key-A", "key-B", "key-C"}
	if !reflect.DeepEqual(cfg.APIKeys, want) {
		t.Fatalf("APIKeys = %v, want %v", cfg.APIKeys, want)
	}
	if cfg.NoKeyFailThreshold != 5 {
		t.Fatalf("NoKeyFailThreshold = %d, want 5", cfg.NoKeyFailThreshold)
	}
	if cfg.NoKeyProbeInterval.Seconds() != 2 {
		t.Fatalf("NoKeyProbeInterval = %v, want 2s", cfg.NoKeyProbeInterval)
	}
}

func TestLoadMissingKeysFile(t *testing.T) {
	t.Setenv("ZEN_API_KEYS_FILE", "/nonexistent/keys.txt")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "ZEN_API_KEYS_FILE") {
		t.Fatalf("expected error about missing key file, got %v", err)
	}
}

func TestLoadEmptyKeysFile(t *testing.T) {
	path := writeKeysFile(t, "\n# only comments\n\n")
	t.Setenv("ZEN_API_KEYS_FILE", path)
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "contains no keys") {
		t.Fatalf("expected error for empty key file, got %v", err)
	}
}

func TestLoadInvalidThreshold(t *testing.T) {
	path := writeKeysFile(t, "key-A\n")
	t.Setenv("ZEN_API_KEYS_FILE", path)
	t.Setenv("ZEN_NO_KEY_FAIL_THRESHOLD", "0")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "ZEN_NO_KEY_FAIL_THRESHOLD") {
		t.Fatalf("expected threshold error, got %v", err)
	}
}
