;; JavaScript Structure Queries — for .js/.jsx/.mjs/.cjs files
;; Uses tree-sitter-javascript grammar. TS-specific nodes (enum, JSX) excluded.
;;
;; Captures:
;;   @fn        → function-like nodes
;;   @class     → class declarations
;;   @interface → interface/type alias (won't match in JS but harmless)
;;   @call      → call/new expressions
;;   @import    → import/export statements

;; ── Function definitions ──
(function_declaration) @fn
(generator_function_declaration) @fn
(function_expression) @fn
(method_definition) @fn
(arrow_function) @fn

;; ── Variable declarators (Rust checks if value is function-like) ──
(variable_declarator) @fn

;; ── Class ──
(class_declaration) @class

;; ── Imports / exports ──
(import_statement) @import
(export_statement) @import

;; ── Calls ──
(call_expression) @call
(new_expression) @call
