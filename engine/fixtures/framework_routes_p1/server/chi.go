// Chi fixture — Route closure prefix propagation; {id} params kept as-is.
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()

	r.Get("/health", healthCheck)

	r.Route("/api", func(r chi.Router) {
		r.Get("/users", listUsers)
		r.Post("/users", createUser)
		r.Get("/users/{id}", getUser)
	})
}

func healthCheck(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func listUsers(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("users"))
}

func createUser(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(201)
}

func getUser(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("user"))
}
