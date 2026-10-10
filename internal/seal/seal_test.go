package seal

import (
	"bytes"
	"errors"
	"testing"
)

func TestSealRoundTripAndTamper(t *testing.T) {
	box, err := New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed := box.Seal([]byte("refresh-token"), []byte("ctx"))
	if bytes.Contains(sealed, []byte("refresh-token")) {
		t.Fatal("sealed value contains the plaintext")
	}
	opened, err := box.Open(sealed, []byte("ctx"))
	if err != nil || string(opened) != "refresh-token" {
		t.Fatalf("Open = %q, %v", opened, err)
	}

	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 1
	if _, err := box.Open(tampered, []byte("ctx")); !errors.Is(err, ErrOpen) {
		t.Fatalf("tampered Open err = %v", err)
	}
	if _, err := box.Open(sealed, []byte("other")); !errors.Is(err, ErrOpen) {
		t.Fatalf("wrong-context Open err = %v", err)
	}
	if _, err := box.Open(sealed[:5], []byte("ctx")); !errors.Is(err, ErrOpen) {
		t.Fatalf("short Open err = %v", err)
	}
	other, _ := New(bytes.Repeat([]byte{8}, 32))
	if _, err := other.Open(sealed, []byte("ctx")); !errors.Is(err, ErrOpen) {
		t.Fatalf("wrong-key Open err = %v", err)
	}
	if _, err := New([]byte("short")); err == nil {
		t.Fatal("New accepted a short key")
	}
}
