// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

mod node;
mod edge;
mod graph;
pub(crate) mod id;
pub mod merge;
pub mod resolver;
pub mod query;

pub use node::{Node, NodeKind};
pub use edge::{Edge, EdgeKind};
pub use graph::Graph;
pub use id::{EdgeId, NodeId};
pub use merge::GraphMerger;
pub use resolver::CrossFileResolver;
