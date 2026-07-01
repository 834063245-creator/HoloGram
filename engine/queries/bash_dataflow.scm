;; Bash dataflow queries

;; Writes — variable assignments
(variable_assignment name: (variable_name) @write)

;; All variable references
(variable_name) @read
;; Command names as reads
(command_name (word) @read)

;; Scope boundaries
(function_definition) @scope_fn

;; Sequences
(command) @sequence
