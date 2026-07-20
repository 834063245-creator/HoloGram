;; Zig dataflow queries
;; tree-sitter-zig 1.1

;; Writes
;; var x: T = ... / const x = ...
(variable_declaration (identifier) @write)
;; x = y  /  x += y
(assignment_expression left: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn

;; Sequences
(call_expression) @sequence
