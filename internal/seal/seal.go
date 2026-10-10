// Package seal encrypts small secrets at rest with AES-256-GCM.
package seal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

// Box seals and opens values with one 32-byte key. Sealed output is the
// random nonce followed by the ciphertext.
type Box struct{ aead cipher.AEAD }

var ErrOpen = errors.New("sealed value is invalid or was tampered with")

func New(key []byte) (*Box, error) {
	if len(key) != 32 {
		return nil, errors.New("seal key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plaintext. Purpose is authenticated but not stored; Open
// must be given the same purpose, which keeps a value sealed for one
// purpose from being accepted for another.
func (b *Box) Seal(plaintext, purpose []byte) []byte {
	nonce := make([]byte, b.aead.NonceSize())
	rand.Read(nonce)
	return b.aead.Seal(nonce, nonce, plaintext, purpose)
}

func (b *Box) Open(sealed, purpose []byte) ([]byte, error) {
	size := b.aead.NonceSize()
	if len(sealed) < size {
		return nil, ErrOpen
	}
	plaintext, err := b.aead.Open(nil, sealed[:size], sealed[size:], purpose)
	if err != nil {
		return nil, ErrOpen
	}
	return plaintext, nil
}
