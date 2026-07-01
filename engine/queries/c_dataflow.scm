;; C/C++ dataflow queries (shared by C and C++)

;; Writes
(assignment_expression left: (identifier) @write)
(init_declarator declarator: (identifier) @write)
;; C++ compound assignment
(compound_assignment_expression left: (identifier) @write)
;; for (int i = ...)
(for_statement initializer: (declaration declarator: (init_declarator declarator: (identifier) @write)))

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn
;; C++ lambda
(lambda_expression) @scope_fn

;; Sequences
(call_expression) @sequence
