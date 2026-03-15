package auth

import "golang.org/x/crypto/bcrypt"

func HashPassphrase(passphrase string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(passphrase), bcrypt.DefaultCost)
	return string(bytes), err
}

func CheckPassphrase(passphrase, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(passphrase)) == nil
}
