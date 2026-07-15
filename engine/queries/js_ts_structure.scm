;; JS/TS Structure Queries — query-based structure extraction
;; Strategy: query finds the NODES, Rust code extracts detail (name, fields, children).
;; This avoids grammar-version-dependent field names and node types in queries.
;;
;; Captures:
;;   @fn        → function-like (Rust checks kind: fn_decl, fn_expr, arrow, method, var_decl)
;;   @class     → class/enum (Rust extracts name + extends/implements)
;;   @interface → interface/type alias (Rust extracts name)
;;   @call      → call/new/JSX (Rust extracts target name)
;;   @import    → import/export (Rust extracts source path)

;; ── Function definitions ──
(function_declaration) @fn
(generator_function_declaration) @fn
(function_expression) @fn
(method_definition) @fn
(arrow_function) @fn

;; ── Variable declarators (Rust checks if value is function-like) ──
(variable_declarator) @fn

;; ── Class / enum ──
(class_declaration) @class
(enum_declaration) @class

;; ── Interface / type alias ──
(interface_declaration) @interface
(type_alias_declaration) @interface

;; ── Imports / exports ──
(import_statement) @import
(export_statement) @import

;; ── Calls ──
(call_expression) @call
(new_expression) @call

;; ── JSX ──
(jsx_self_closing_element) @call
(jsx_opening_tag) @call
