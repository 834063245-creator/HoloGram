;; C/C++ dataflow queries (shared by C and C++)

;; Writes
(assignment_expression left: (identifier) @write)
(init_declarator declarator: (identifier) @write)
;; for (int i = ...)
(for_statement initializer: (declaration declarator: (init_declarator declarator: (identifier) @write)))

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_definition) @scope_fn

;; Sequences
(call_expression) @sequence
