// Axum fixture — router with an inline nest prefix and a multi-method route.
use axum::{routing::get, Router};

async fn list_users() -> &'static str {
    "users"
}

async fn create_user() -> &'static str {
    "created"
}

async fn get_user() -> &'static str {
    "user"
}

async fn health() -> &'static str {
    "ok"
}

fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest(
            "/api",
            Router::new()
                .route("/users", get(list_users).post(create_user))
                .route("/users/:id", get(get_user)),
        )
}
