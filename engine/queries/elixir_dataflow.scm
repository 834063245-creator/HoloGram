;; Elixir dataflow queries

;; Writes (pattern match LHS)
(match_operator left: (identifier) @write)
;; Function parameters
(parameters (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function) @scope_fn
(anonymous_function) @scope_fn

;; Sequences
(function_call) @sequence
