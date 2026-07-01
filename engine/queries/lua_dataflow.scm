;; Lua dataflow queries
;; tree-sitter-lua 0.2

;; Writes
;; local x = ...  /  local x, y = ...
(variable_declaration (variable_list name: (identifier) @write))
;; x = ...
(assignment_statement (variable_list name: (identifier) @write))
;; for k, v in ... do — generic iterator
(for_statement clause: (for_generic_clause (variable_list name: (identifier) @write)))
;; for i = 1, 10 do — numeric
(for_statement clause: (for_numeric_clause name: (identifier) @write))
;; function f(a, b) — parameters
(parameters (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(function_definition) @scope_fn

;; Sequences
(function_call) @sequence
