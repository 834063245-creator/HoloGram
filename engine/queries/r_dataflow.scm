;; R dataflow queries

;; Writes
(assign left: (identifier) @write)
(left_assignment right: (identifier) @write)
(equals_assignment left: (identifier) @write)
;; Function params
(formal_parameters (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn
(lambda_definition) @scope_fn

;; Sequences
(call) @sequence
