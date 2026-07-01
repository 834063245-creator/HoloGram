;; Java dataflow queries

;; Writes
(assignment_expression left: (identifier) @write)
(variable_declarator name: (identifier) @write)
(field_declaration declarator: (variable_declarator name: (identifier) @write))
(enhanced_for_statement name: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(method_declaration) @scope_fn
(constructor_declaration) @scope_fn
(lambda_expression) @scope_fn

;; Sequences
(method_invocation) @sequence
