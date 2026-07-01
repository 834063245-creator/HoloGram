;; Rust dataflow queries

;; Writes
(let_declaration pattern: (identifier) @write)
(assignment_expression left: (identifier) @write)
(compound_assignment_expr left: (identifier) @write)
;; fn params
(parameters (identifier) @write)
(closure_parameters (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_item) @scope_fn
(closure_expression) @scope_fn

;; Sequences
(call_expression) @sequence
