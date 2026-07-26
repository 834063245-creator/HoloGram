// Echo fixture — Group prefix propagation via short var declaration.
package main

import "github.com/labstack/echo/v4"

func main() {
	e := echo.New()

	g := e.Group("/api")
	g.GET("/users", listUsers)
	g.POST("/users", createUser)

	e.GET("/health", healthCheck)
}

func listUsers(c echo.Context) error {
	return c.JSON(200, nil)
}

func createUser(c echo.Context) error {
	return c.JSON(201, nil)
}

func healthCheck(c echo.Context) error {
	return c.String(200, "ok")
}
