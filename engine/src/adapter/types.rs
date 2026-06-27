// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Type representation for LSP-aware call resolution.
//! Mirrors `type_rep.h` — 17+ type kinds. Python first phase uses 8.

use std::fmt;

/// Type representation — tagged union of all type forms the resolver understands.
#[derive(Debug, Clone, PartialEq)]
pub enum Type {
    /// Cannot infer — fallback.
    Unknown,
    /// Named type: "myapp.models.User", "builtins.str"
    Named { qn: String },
    /// Builtin scalar: "int", "str", "bool", "None", etc.
    Builtin { name: String },
    /// Module object: "os", "django.urls"
    Module { qn: String },
    /// Union type: str | None  (Python `X | Y`, `Union[X, Y]`)
    Union { members: Vec<Type> },
    /// Callable / function type: (int, str) -> User
    Callable {
        params: Vec<Type>,
        ret: Box<Type>,
    },
    /// Tuple literal type: (User, int, str)
    Tuple { elems: Vec<Type> },
    /// Generic / parameterized type: List[User], Dict[str, int]
    Template {
        name: String,   // "list", "dict", "Optional", etc.
        args: Vec<Type>,
    },
}

impl Type {
    /// Convenience: named type from a string.
    pub fn named(qn: impl Into<String>) -> Self {
        Type::Named { qn: qn.into() }
    }

    /// Convenience: builtin from a string.
    pub fn builtin(name: impl Into<String>) -> Self {
        Type::Builtin { name: name.into() }
    }

    /// Convenience: module from a string.
    pub fn module(qn: impl Into<String>) -> Self {
        Type::Module { qn: qn.into() }
    }

    /// Convenience: single-element optional = Union[T, None].
    pub fn optional(t: Type) -> Self {
        Type::Union {
            members: vec![t, Type::Builtin { name: "None".into() }],
        }
    }

    /// Convenience: template type.
    pub fn template(name: impl Into<String>, args: Vec<Type>) -> Self {
        Type::Template {
            name: name.into(),
            args,
        }
    }

    /// Is this type unknown?
    pub fn is_unknown(&self) -> bool {
        matches!(self, Type::Unknown)
    }

    /// Resolve alias chains (max 16 levels, cycle-safe).
    /// In Rust we don't have alias types at Type level — aliases are in TypeRegistry.
    /// This is a no-op; the registry resolves aliases during lookup.
    pub fn resolve_alias(&self) -> &Self {
        self
    }
}

impl fmt::Display for Type {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Type::Unknown => write!(f, "?"),
            Type::Named { qn } => write!(f, "{}", qn),
            Type::Builtin { name } => write!(f, "{}", name),
            Type::Module { qn } => write!(f, "module:{}", qn),
            Type::Union { members } => {
                let s: Vec<String> = members.iter().map(|m| m.to_string()).collect();
                write!(f, "{}", s.join(" | "))
            }
            Type::Callable { params, ret } => {
                let p: Vec<String> = params.iter().map(|m| m.to_string()).collect();
                write!(f, "({}) -> {}", p.join(", "), ret)
            }
            Type::Tuple { elems } => {
                let e: Vec<String> = elems.iter().map(|m| m.to_string()).collect();
                write!(f, "({})", e.join(", "))
            }
            Type::Template { name, args } => {
                let a: Vec<String> = args.iter().map(|m| m.to_string()).collect();
                write!(f, "{}[{}]", name, a.join(", "))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_named_type() {
        let t = Type::named("myapp.models.User");
        assert_eq!(t.to_string(), "myapp.models.User");
    }

    #[test]
    fn test_optional() {
        let t = Type::optional(Type::named("User"));
        assert!(matches!(t, Type::Union { .. }));
        if let Type::Union { members } = &t {
            assert_eq!(members.len(), 2);
        }
    }

    #[test]
    fn test_is_unknown() {
        assert!(Type::Unknown.is_unknown());
        assert!(!Type::named("Foo").is_unknown());
    }

    #[test]
    fn test_template_display() {
        let t = Type::template("list", vec![Type::builtin("int")]);
        assert_eq!(t.to_string(), "list[int]");
    }

    #[test]
    fn test_union_display() {
        let t = Type::Union {
            members: vec![Type::named("User"), Type::builtin("None")],
        };
        assert!(t.to_string().contains("|"));
    }
}
