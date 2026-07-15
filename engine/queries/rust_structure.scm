;; Rust Structure Queries — replaces generic_walk for .rs files
;; Captures:
;;   @fn        → creates Function node + Defines edge
;;   @class     → creates Class node + Defines edge (struct/enum)
;;   @interface → creates Interface node + Defines edge (trait/type alias)
;;   @call      → creates Calls edge (scope-attributed by Rust processor)
;;   @import    → creates Imports edge
;;   @inherit   → creates Inherits edge (impl Trait for Type)
;;   @name      → symbol name
;;   @target    → import path string
;;   @trait_name → trait name in impl block
;;   @type_name  → type name in impl block

;; ── Function definitions ──
(function_item name: (identifier) @name) @fn

;; ── Struct definitions ──
(struct_item name: (type_identifier) @name) @class

;; ── Enum definitions ──
(enum_item name: (type_identifier) @name) @class

;; ── Trait definitions ──
(trait_item name: (type_identifier) @name) @interface

;; ── Type aliases ──
(type_item name: (type_identifier) @name) @interface

;; ── impl blocks: impl Trait for Type → Type inherits Trait ──
;; ponytail: tree-sitter-rust 0.23 uses impl_item with trait and type fields
(impl_item
  trait: (type_identifier) @trait_name
  type: (type_identifier) @type_name) @inherit

;; ── impl blocks: bare impl Type (no trait) → creates class scope ──
(impl_item type: (type_identifier) @_impl_type) @_impl_block

;; ── use declarations (imports) ──
(use_declaration) @import

;; ── mod declarations ──
(mod_item name: (identifier) @name) @_mod

;; ── Call expressions (plain identifier) ──
(call_expression function: (identifier) @name) @call

;; ── Call expressions (field/method: a.b()) ──
(call_expression
  function: (field_expression
    field: (field_identifier) @name)) @call

;; ── Macro invocations: foo!() → creates Calls edge ──
(macro_invocation) @call

;; ── Call expressions (scoped path: std::fs::read()) ──
(call_expression
  function: (scoped_identifier
    name: (identifier) @name)) @call
