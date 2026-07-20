;; Ruby dataflow queries

;; Writes
(assignment left: (identifier) @write)
(method_parameters (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(method) @scope_fn
(lambda) @scope_fn
(block) @scope_fn

;; Sequences
(call) @sequence
