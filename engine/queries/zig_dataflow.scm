;; Zig dataflow queries
;; tree-sitter-zig 1.1 — minimal pattern set

;; Writes — variable declaration with identifier
(variable_declaration (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn

;; Sequences
(call_expression) @sequence
