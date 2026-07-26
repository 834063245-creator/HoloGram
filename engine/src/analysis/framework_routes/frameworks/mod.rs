// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Per-framework route detectors. Each module exports `is_*_candidate` and
//! `detect_*_routes` functions called by the dispatcher.

pub(super) mod actix;
pub(super) mod aspnet;
pub(super) mod axum;
pub(super) mod chi;
pub(super) mod django;
pub(super) mod echo;
pub(super) mod express;
pub(super) mod fastapi;
pub(super) mod fastify;
pub(super) mod fiber;
pub(super) mod flask;
pub(super) mod gin;
pub(super) mod hono;
pub(super) mod koa;
pub(super) mod laravel;
pub(super) mod nestjs;
pub(super) mod nextjs;
pub(super) mod phoenix;
pub(super) mod rails;
pub(super) mod rocket;
pub(super) mod sinatra;
pub(super) mod slim;
pub(super) mod spring;
pub(super) mod sveltekit;
