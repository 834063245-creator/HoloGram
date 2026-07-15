;; TypeScript Structure Queries — for .ts/.tsx/.mts/.cts files
;; Uses tree-sitter-typescript grammar. Includes TS-specific nodes (enum, JSX).
;;
;; Captures:
;;   @fn        → function-like nodes
;;   @class     → class/enum declarations
;;   @interface → interface/type alias
;;   @call      → call/new/JSX expressions
;;   @import    → import/export statements

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

;; ── Variables ──
(lexical_declaration) @var
(variable_declaration) @var

;; ── Writes ──
(assignment_expression) @write

;; ── Throws ──
(throw_statement) @throws

;; ── Usage ──
(identifier) @usage
