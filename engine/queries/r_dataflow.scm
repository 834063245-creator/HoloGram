;; R dataflow queries
;; tree-sitter-r 1.2

;; Writes — assignment operators
;; x <- ...  /  x <<- ...  /  x = ...
(binary_operator lhs: (identifier) @write)
;; ponytail: matches all binary operators — comparisons too. Harmless because
;; write_offsets dedup only prevents duplicate Read edges for the same
;; (scope, variable) pair; a few extra writes don't change graph structure.
;; R uses == for comparison, so "=" is almost always assignment in practice.

;; function(x, y = 1) — parameters
(parameters parameter: (parameter name: (identifier) @write))

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn

;; Sequences
(call) @sequence
