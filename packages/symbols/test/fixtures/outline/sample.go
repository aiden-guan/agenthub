// Package auth is a sample Go file for the outline tests (and the mapping property test).
package auth

import "fmt"

import (
	"os"
	str "strings"
)

// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration
// Login logs a user in.
func Login(user string, password string) (*Session, error) {
	return authenticate(user, password)
}

// A detached note about the file.

// Session is a session.
type Session struct {
	ID    string `json:"id"`
	token string // the secret
}

type (
	// Store keeps sessions.
	Store interface {
		Get(id string) (*Session, error)
	}
	Cache[K comparable, V any] map[K][]V
)

type ID = string

const MaxRetries = 3

const (
	// Admin is the admin role.
	Admin Role = iota // the first
	User
)

var (
	current *Session
	handler = func(w http.ResponseWriter, xs []string) error { return nil }
)

var a, b = 1, 2

// Refresh renews the session.
func (s *Session) Refresh(force bool) error {
	s.token = rotate(s.token, force)
	return nil
}

func (s Session) Close() {}

func (c *Cache[K, V]) Put(k K, v V) {}

func init() {}

func init() {}
