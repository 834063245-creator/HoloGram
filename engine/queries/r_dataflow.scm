;; R dataflow queries
;; tree-sitter-r 1.2 — minimal: reads + scope + sequences only.
;; Write/assign patterns omitted (R uses <- binary operator, node types unknown).

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn

;; Sequences
(call) @sequence
