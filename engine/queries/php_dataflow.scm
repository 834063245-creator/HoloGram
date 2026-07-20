;; PHP dataflow queries

;; Writes
(assignment_expression left: (variable_name) @write)
;; PHP variable names are $name — engine needs to handle the $ prefix
(variable_name) @write

;; All variable names — engine filters to reads (subtracts writes)
(variable_name) @read
;; Plain identifiers (function calls, class refs)
(name) @read

;; Scope boundaries
(method_declaration) @scope_fn
(function_definition) @scope_fn
(arrow_function) @scope_fn

;; Sequences
(function_call_expression) @sequence
