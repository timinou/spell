# Combobulate Procedure DSL and Rule System: Complete Research

**Date**: 2026-04-11
**Source**: Deep analysis of Combobulate's Elisp implementation
**Status**: Complete specification document for Rust replication

---

## Executive Summary

Combobulate is a structured editing system built on Tree-Sitter that uses two main systems:

1. **Production Rules**: A declarative data structure mapping each node type to its fields and possible children
2. **Procedure DSL**: A declarative query language for finding and selecting nodes based on syntactic context

This document provides the complete technical specification needed to replicate these systems in Rust.

---

## Part 1: Production Rules System

### 1.1 Rule Data Structure

Rules are stored in constants generated per language. The structure is:

```elisp
(defconst combobulate-rules-LANGUAGE
  '(("node-type" (:*unnamed* (children...) :field-name (possible-children...)))
    ...))
```

Each rule entry is a 2-element list:
- **[0] Node type**: String (e.g., "if_statement", "function_declaration")
- **[1] Properties map**: A plist containing:
  - `:*unnamed*`: List of node types that can appear as unnamed/anonymous children
  - `:field-name`: List of node types that can appear in that named field

### 1.2 Concrete Examples: JavaScript/TypeScript Rules

```elisp
("if_statement" 
 (:*unnamed* nil 
  :alternative ("else_clause") 
  :condition ("parenthesized_expression") 
  :consequence ("statement")))

("function_declaration" 
 (:*unnamed* nil 
  :body ("statement_block") 
  :name ("identifier") 
  :parameters ("formal_parameters") 
  :return_type ("type_annotation" "asserts_annotation" "type_predicate_annotation") 
  :type_parameters ("type_parameters")))

("call_expression" 
 (:*unnamed* nil 
  :arguments ("template_string" "arguments") 
  :function ("expression") 
  :type_arguments ("type_arguments")))
```

### 1.3 Concrete Examples: Python Rules

```elisp
("if_statement" 
 (:*unnamed* nil 
  :alternative ("elif_clause" "else_clause") 
  :condition ("expression") 
  :consequence ("block")))

("function_definition" 
 (:*unnamed* nil 
  :body ("block") 
  :name ("identifier") 
  :parameters ("parameters") 
  :return_type ("type") 
  :type_parameters ("type_parameter")))

("class_definition" 
 (:*unnamed* nil 
  :body ("block") 
  :name ("identifier") 
  :superclasses ("argument_list") 
  :type_parameters ("type_parameter")))
```

### 1.4 Inverse Rules

For each language, an inverse rules table is also generated:

```elisp
(defconst combobulate-rules-LANGUAGE-inverse
  '(("if_statement" ("module" "block"))
    ("function_declaration" ("module" "declaration"))
    ...))
```

This maps: **node type** → **list of possible parent types**

Used for reverse traversal and parent-based navigation.

### 1.5 Node Type Collections

Three supporting constants per language:

1. **All types**:
   ```elisp
   (defconst combobulate-rules-LANGUAGE-types
     '("identifier" "if_statement" "function_declaration" ...))
   ```

2. **Supertypes** (abstract/synthetic types in grammar, not in CST):
   ```elisp
   (defconst combobulate-rules-LANGUAGE-supertypes
     '("expression" "statement" "declaration" ...))
   ```
   These are never directly in the parse tree but used in rules to group node types.

3. **Registration** (per language):
   ```elisp
   (defconst combobulate-rules-alist
     '((python combobulate-rules-python)
       (tsx combobulate-rules-tsx)
       (javascript combobulate-rules-javascript)))
   ```

---

## Part 2: Procedure DSL - Complete Specification

### 2.1 Overall Structure

A procedure is a declarative form for finding nodes at/near point:

```elisp
(:activation-nodes (ACTIVATION-NODE-RULE ...)
 :selector SELECTOR-RULE)
```

**Two-phase execution**:
1. **Activation phase**: Find nodes at/near point that match
2. **Selection phase** (optional): Further filter children/siblings of activated node

### 2.2 Activation Node Rules

Each activation node rule is:

```elisp
(:nodes RULES
 [:position POSITION-RULE]
 [:has-parent HAS-PARENT-RULE]
 [:has-ancestor HAS-ANCESTOR-RULE]
 [:has-fields FIELD-LIST])
```

#### `:nodes` (Required)

Rules expand to actual node types. Rules can be:

**1. String (literal node type)**:
```elisp
"if_statement"
"identifier"
```

**2. Rule expansion forms**:

a) `(rule NODE-TYPE)` - All fields of a node:
```elisp
(rule "if_statement")
; Expands to: "if_statement"
```

b) `(rule NODE-TYPE :field1 :field2)` - Specific fields only:
```elisp
(rule "pair" :key)
; Gets only node types that can appear in the :key field of "pair"
```

c) `(irule NODE-TYPE)` - Inverted rule (parents):
```elisp
(irule "statement")
; Expands to parent types that can contain "statement"
```

d) `(rx REGEXP)` - Regex match against all node types:
```elisp
(rx "statement" "clause")
; Matches: if_statement, case_clause, try_statement, ...
```

e) `(rule-rx REGEXP)` - Regex then expand rules:
```elisp
(rule-rx "expression")
; Matches "expression" + expands all "expression" rules
```

**3. Operators**:

a) `(exclude INCLUSIONS EXCLUSIONS)`:
```elisp
(exclude ("statement") ("if_statement"))
; All statements except if_statement
```

b) `t` or `(all)` - All node types in the language

**4. Lists** - Union of multiple rules:
```elisp
((rule "expression") (rule "statement") "identifier")
```

#### `:position` (Optional, default: `any`)

Controls where in the node point must be:

- `any` or `nil`: Point anywhere in node (beginning, middle, or end)
- `at`: Point must be at beginning of node (first character)
- `in`: Point must be inside node but NOT at beginning

**Activation logic**:
```elisp
(cond
  ((eq position 'any)
   (or (point-at-beginning-of-node-p) (point-in-node-range-p)))
  ((eq position 'at)
   (point-at-beginning-of-node-p))
  ((eq position 'in)
   (and (point-in-node-range-p) (not (point-at-beginning-of-node-p)))))
```

#### `:has-parent` (Optional, max 1 of :has-*)

Restricts to nodes whose **immediate parent** matches:

```elisp
:has-parent ("class_body")
; Node must have class_body as immediate parent
```

The rule expansions apply here too.

#### `:has-ancestor` (Optional, max 1 of :has-*)

Restricts to nodes with **any ancestor** matching:

```elisp
:has-ancestor ("if_statement")
; Any ancestor can be if_statement (not just immediate parent)
```

#### `:has-fields` (Optional)

Restricts to nodes in specific **field names** of parent:

```elisp
:has-fields "key"
; Node is in the :key field of its parent (e.g., key in object pair)
```

Can be a string or list:
```elisp
:has-fields ("key" "value")
```

### 2.3 Selection Rules

Applied AFTER activation to further refine results. Optional.

```elisp
:selector (:choose CHOOSE
           :match-query QUERY-MATCHER
           :match-children NODE-MATCHER
           :match-siblings NODE-MATCHER)
```

#### `:choose` (Optional, default: `parent`)

Which node to operate on:
- `node`: Use the action node (the one matched by activation)
- `parent`: Use its parent node (default)

#### `:match-query` (Optional, max 1 matcher)

Filter using a Tree-Sitter or Combobulate query:

```elisp
:match-query (:query (object (pair (_) @match)+) 
              :engine combobulate)
```

Properties:
- `:query`: S-exp query (for Combobulate) or Tree-Sitter query syntax
- `:engine`: `combobulate` (default) or `treesitter`
- `:discard-rules`: Optional rules to exclude from results

Nodes matched get marked:
- `@match`: Include in results
- `@discard`: Exclude from results
- Unmarked: Use `:default-mark`

#### `:match-children` (Optional, max 1 matcher)

Filter **immediate children** of chosen node:

```elisp
:match-children (:match-rules ("pair")
                 :discard-rules ("comment")
                 :default-mark @match
                 :anonymous nil)
```

Properties:
- `:match-rules`: Include only these types, or `t` for all
- `:discard-rules`: Explicitly exclude types
- `:anonymous`: Include anonymous nodes (default: nil)
- `:default-mark`: Mark for unmatched nodes (@match or @discard)

**Only ONE of `:match-rules` or `:discard-rules`** can be used.

#### `:match-siblings` (Optional, max 1 matcher)

Filter **siblings** (left-right linear navigation):

Same properties as `:match-children`.

---

## Part 3: Complete DSL Execution Flow

### 3.1 Phase 1: Activation

```
Input: PT-OR-NODE, PROCEDURES
│
├─ Collect all nodes at/in point:
│  ├─ Node at point start (highest priority)
│  ├─ All nodes at point start
│  └─ All ancestor nodes
│
└─ For each procedure, test each activation-nodes rule:
   ├─ Check :nodes expanded rule matches action-node type
   ├─ Check :position constraint (at/in/any)
   ├─ Check :has-fields (if specified)
   ├─ Check :has-parent (if specified, returns parent or nil)
   ├─ Check :has-ancestor (if specified, returns ancestor or nil)
   │
   └─ On FIRST MATCH: Return activation result with:
      ├─ activation-node: The rule that matched
      ├─ action-node: The node at point
      ├─ parent-node: Parent (if matched constraint)
      └─ matched-activation: t
```

**Crucially**: Returns on first successful match (unless `exhaustive: t`).

### 3.2 Phase 2: Selection (if :selector present)

```
Input: procedure-result from Phase 1
│
├─ Determine chosen node:
│  └─ If :choose = 'node: use action-node
│     Else: use parent-node (default)
│
└─ Apply selector matcher:
   ├─ If :match-query:
   │  └─ Run query against chosen-node
   │     Return marked nodes (@match/@discard)
   │
   ├─ If :match-children:
   │  └─ Get children of chosen-node
   │     Mark by `:match-rules`/`:discard-rules`
   │     Return marked nodes
   │
   └─ If :match-siblings:
      └─ Get siblings of chosen-node
         Mark by `:match-rules`/`:discard-rules`
         Return marked nodes

Result: selected-nodes with marks (@match/@discard/neutral)
```

### 3.3 Phase 3: Finalization

```
Input: selected-nodes (if selection) or action-node (if no selection)
│
└─ Filter for @match marks:
   ├─ Extract nodes marked @match
   ├─ Store in matched-nodes field
   └─ Return as matched-nodes (for caller to use)

Final result:
  matched-nodes: Nodes caller will interact with
  matched-activation: t (indicates successful match)
  matched-selection: t (if selector was used) or 'n/a
```

---

## Part 4: Concrete Trace Examples

### Example 1: "Splice up on if-statement in Python"

**Scenario**: Cursor at start of statement inside an if-statement block. Want to move statement up (out of if).

**Procedure** (simplified):
```elisp
(:activation-nodes
 ((:nodes ((rule "_simple_statement") (rule "_compound_statement"))
   :has-parent ("block")))
 :selector
 (:choose parent
  :match-children (:match-rules (t)
                   :discard-rules ("block"))))
```

**Execution**:

1. **Activation Phase**:
   - Point at: `return x` statement inside if block
   - Action node type: `return_statement` (matches rule "_simple_statement")
   - Position constraint: `any` (satisfied)
   - `:has-parent ("block")`: Parent is block → ✓
   - Activation succeeds
   - parent-node = the `block` node

2. **Selection Phase**:
   - chosen-node = parent-node (the `block`)
   - `:match-children` with discard-rules ("block")
   - Get all children of block
   - Filter out nested blocks
   - Result: List of statements in block

3. **Finalization**:
   - Filter for @match marks
   - Return all statements in block
   - User can navigate/splice them

### Example 2: "Drag a function argument in TypeScript"

**Scenario**: Cursor on function argument `foo` in `myFunc(foo, bar)`. Want to drag it left/right.

**Procedure**:
```elisp
(:activation-nodes
 ((:nodes ((rule "primary_expression") (rule "expression"))
   :has-fields "arguments"
   :has-ancestor ("call_expression")))
 :selector
 (:choose parent
  :match-children (:match-rules (t)
                   :discard-rules ("comment"))))
```

**Execution**:

1. **Activation Phase**:
   - Point at: `foo` identifier
   - Action node: identifier (matches "primary_expression")
   - `:has-fields "arguments"`: Node is in "arguments" field → ✓
   - `:has-ancestor ("call_expression")`: Some ancestor is call_expression → ✓
   - parent-node = the `call_expression` node

2. **Selection Phase**:
   - chosen-node = parent-node (call_expression)
   - `:match-children`: Get arguments node children
   - Result: [foo, bar] (the argument expressions)

3. **Finalization**:
   - Return [foo, bar]
   - Caller can use M-n/M-p to navigate siblings

### Example 3: "Clone a list item in JSON"

**Scenario**: Point on list item. Want to duplicate it.

**Procedure**:
```elisp
(:activation-nodes
 ((:nodes (t)
   :has-parent ("array")))
 :selector
 (:choose parent
  :match-children t))
```

**Execution**:

1. **Activation Phase**:
   - Point at: `42` (number in array)
   - Action node: number (matches any via `t`)
   - `:has-parent ("array")`: Parent is array → ✓
   - parent-node = the array

2. **Selection Phase**:
   - chosen-node = array
   - `:match-children t`: Get all children
   - Result: All array elements

3. **Finalization**:
   - Return all array elements
   - User clones the one at point

---

## Part 5: Language-Specific Differences

### 5.1 JavaScript/TypeScript Specifics

**Key node types**:
- `function_declaration`, `arrow_function`, `generator_function`
- `call_expression` (function calls with `.function` and `.arguments` fields)
- `jsx_element`, `jsx_opening_element`, `jsx_closing_element` (JSX-specific)
- `class_declaration` with `class_body`
- Type-related: `type_annotation`, `type_parameters`, `generic_type`

**Field names**:
- `body`: Code block content
- `arguments`: Function call args
- `parameters`: Function definition params
- `type_annotation`: `: Type` syntax
- `name`: Identifier of function/class
- `type_arguments`: `<Type>` syntax

**Anonymous vs Named**:
- `:*unnamed*`: Operators, keywords (`;`, `{`, `}`, etc.)
- Fields: Declared structure

### 5.2 Python Specifics

**Key node types**:
- `function_definition` (not `function_declaration`)
- `class_definition` (classes)
- `if_statement`, `for_statement`, `while_statement`, `with_statement`, `try_statement`
- `_simple_statement` (supertype: return, break, continue, etc.)
- `_compound_statement` (supertype: if, for, def, class, etc.)
- `block`: Python's indented blocks (required structure)
- `decorator`: `@decorator` syntax

**Field names**:
- `body`: Code block (block node)
- `parameters`: Function params
- `consequence`: if/for/while/with body
- `alternative`: else clause
- `condition`: if/while condition

**Critical differences**:
- Python REQUIRES explicit `block` nodes for all compound statements
- No `{}`; indentation-based structure
- `_simple_statement` and `_compound_statement` supertypes are essential
- Decorators are separate nodes in tree (`decorated_definition` wraps function)

### 5.3 Other Languages

**CSS**:
- `block`, `rule_set`, `at_rule`
- Simpler structure, limited nesting

**HTML/JSX**:
- `element`, `opening_tag`, `closing_tag`, `text`
- Bidirectional navigation needed

**JSON**:
- `object`, `array`, `pair`
- Simple, highly structured

---

## Part 6: Key DSL Semantics and Guarantees

### 6.1 Rule Expansion Semantics

- **`(rule X)`**: Expands to direct children of X (not recursively)
- **`(irule X)`**: Inverse lookup; returns types that have X as child
- **`(rx PATTERN)`**: String regex match against all node types
- **`(rule-rx PATTERN)`**: Regex match THEN expand each hit
- **`(exclude A B)`**: Difference operation: all A minus all B
- **`t`**: All node types (eager expansion at time of use)

### 6.2 Position Constraint Semantics

```
Point is at position P in node N:

:position at     → P == N.start (first byte of node)
:position in     → N.start < P <= N.end (inside, not at start)
:position any    → N.start == P || (N.start < P <= N.end)
                   (anywhere in or at node)
```

### 6.3 Parent/Ancestor Traversal

```
:has-parent   → Immediate parent (N.parent)
:has-ancestor → Any ancestor in chain (N.parent.parent...root)
```

Both perform rule matching on the parent/ancestor TYPE.

### 6.4 Field Membership

```
:has-fields "key"
→ Node must be inside a field named "key" in parent

Node.parent has fields: {:key [...], :value [...], ...}
Node must be in one of :has-fields list
```

### 6.5 Selection Marking Model

Nodes returned by selectors can be marked:

```
@match   → Include in final matched-nodes
@discard → Exclude from final matched-nodes
(unmarked) → Use :default-mark to decide (@match or @discard)
```

Used to control which nodes the caller sees.

---

## Part 7: Rust Replication Strategy

### 7.1 Data Structures Needed

```rust
// Production rules
pub struct ProductionRule {
    pub unnamed_children: Vec<String>,      // :*unnamed*
    pub fields: HashMap<String, Vec<String>>, // :field-name → child types
}

pub type ProductionRules = HashMap<String, ProductionRule>;

// Language registration
pub struct LanguageRules {
    pub rules: ProductionRules,
    pub inverse_rules: ProductionRules,
    pub all_types: Vec<String>,
    pub supertypes: Vec<String>,
}

pub static RULES_BY_LANGUAGE: Lazy<HashMap<&str, LanguageRules>> = ...;
```

### 7.2 Procedure DSL Parser

Need to parse Elisp-like forms:

```rust
pub enum RuleExpr {
    String(String),                           // "node-type"
    Rule { name: String, fields: Vec<String> }, // (rule "X" :field1 :field2)
    InvertedRule(String),                    // (irule "X")
    Regex(String),                            // (rx PATTERN)
    RuleRegex(String),                        // (rule-rx PATTERN)
    Exclude { include: Box<RuleExpr>, exclude: Box<RuleExpr> },
    All,                                      // t or (all)
    Union(Vec<RuleExpr>),                    // Multiple rules
}

pub enum PositionConstraint {
    Any,
    At,
    In,
}

pub struct ActivationNodeRule {
    pub nodes: RuleExpr,
    pub position: PositionConstraint,
    pub has_parent: Option<RuleExpr>,
    pub has_ancestor: Option<RuleExpr>,
    pub has_fields: Option<Vec<String>>,
}

pub enum SelectorMatcher {
    MatchQuery { query: String, engine: QueryEngine, discard_rules: Option<RuleExpr> },
    MatchChildren(NodeMatcher),
    MatchSiblings(NodeMatcher),
}

pub struct NodeMatcher {
    pub match_rules: Option<Vec<String>>,
    pub discard_rules: Option<Vec<String>>,
    pub anonymous: bool,
    pub default_mark: Mark,
}

pub enum Mark {
    Match,
    Discard,
    Neutral,
}

pub struct Procedure {
    pub activation_nodes: Vec<ActivationNodeRule>,
    pub selector: Option<SelectorRule>,
}

pub struct SelectorRule {
    pub choose: SelectorTarget,
    pub matcher: SelectorMatcher,
}

pub enum SelectorTarget {
    Node,
    Parent,
}
```

### 7.3 Execution Engine

```rust
pub struct ProcedureResult {
    pub activation_node: ActivationNodeRule,
    pub action_node: Node,
    pub parent_node: Option<Node>,
    pub selected_nodes: Vec<(Mark, Node)>,
    pub matched_nodes: Vec<Node>,
    pub matched_activation: bool,
    pub matched_selection: Option<bool>, // Some(true/false) or None('n/a)
}

pub fn apply_procedure(
    procedure: &Procedure,
    node: Node,
    point: usize,
) -> Option<ProcedureResult> {
    // Phase 1: Activation
    for activation_rule in &procedure.activation_nodes {
        if let Some(parent) = try_activation(activation_rule, &node, point) {
            let mut result = ProcedureResult::new(activation_rule, &node, parent);
            
            // Phase 2: Selection (if present)
            if let Some(selector) = &procedure.selector {
                apply_selector(&mut result, selector);
            }
            
            // Phase 3: Finalization
            finalize_result(&mut result);
            
            return Some(result);
        }
    }
    None
}

fn try_activation(
    rule: &ActivationNodeRule,
    node: &Node,
    point: usize,
) -> Option<Node> {
    // Check :nodes
    let expanded = expand_rules(&rule.nodes)?;
    if !expanded.contains(&node.kind()) { return None; }
    
    // Check :position
    if !check_position(&rule.position, node, point) { return None; }
    
    // Check :has-fields
    if let Some(fields) = &rule.has_fields {
        if !check_has_field(node, fields) { return None; }
    }
    
    // Check :has-parent / :has-ancestor
    let parent = if let Some(parent_rule) = &rule.has_parent {
        check_has_parent(node, parent_rule)?
    } else if let Some(ancestor_rule) = &rule.has_ancestor {
        check_has_ancestor(node, ancestor_rule)?
    } else {
        None
    };
    
    Some(parent.unwrap_or_else(|| node.parent()))
}
```

### 7.4 Expansion Engine

```rust
pub fn expand_rules(expr: &RuleExpr, rules: &ProductionRules) -> Vec<String> {
    match expr {
        RuleExpr::String(s) => vec![s.clone()],
        RuleExpr::Rule { name, fields } => {
            let rule = rules.get(name)?;
            if fields.is_empty() {
                // All fields
                let mut result = rule.unnamed_children.clone();
                for field_nodes in rule.fields.values() {
                    result.extend(field_nodes.clone());
                }
                result
            } else {
                // Specific fields
                fields.iter()
                    .filter_map(|f| rule.fields.get(f))
                    .flat_map(|nodes| nodes.clone())
                    .collect()
            }
        }
        RuleExpr::InvertedRule(name) => {
            // Lookup in inverse rules
            inverse_rules.get(name)
                .map(|rule| rule.unnamed_children.clone())
                .unwrap_or_default()
        }
        RuleExpr::Regex(pattern) => {
            let re = Regex::new(pattern).ok()?;
            all_types.iter()
                .filter(|t| re.is_match(t))
                .cloned()
                .collect()
        }
        RuleExpr::RuleRegex(pattern) => {
            let re = Regex::new(pattern).ok()?;
            let matched_types: Vec<_> = all_types.iter()
                .filter(|t| re.is_match(t))
                .cloned()
                .collect();
            matched_types.iter()
                .flat_map(|t| expand_rules(&RuleExpr::Rule { 
                    name: t.clone(), 
                    fields: vec![] 
                }, rules))
                .collect()
        }
        RuleExpr::Exclude { include, exclude } => {
            let included = expand_rules(include, rules);
            let excluded = expand_rules(exclude, rules);
            included.into_iter()
                .filter(|t| !excluded.contains(t))
                .collect()
        }
        RuleExpr::All => all_types.clone(),
        RuleExpr::Union(exprs) => {
            exprs.iter()
                .flat_map(|e| expand_rules(e, rules))
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        }
    }
}
```

---

## Part 8: Critical Insights for Replication

### 8.1 Performance Characteristics

- **Rule expansion**: Eager at activation time (not lazy)
- **Node collection**: Smallest set first (at point) → larger (ancestors)
- **Matching**: Short-circuit on first successful procedure (unless exhaustive)
- **Caching**: Production rules are static per language (cache heavily)

### 8.2 Semantic Subtleties

1. **Supertype expansion**: When encountering supertype like "expression" in rules, expand inline to concrete types. Supertypes never appear in actual parse tree.

2. **Anonymous nodes**: Tree-sitter marks some nodes "anonymous" (e.g., operators, keywords). They appear in `:*unnamed*` field.

3. **Field ordering**: Fields define the structure; only nodes matching field types are valid children.

4. **Parent-checking semantics**:
   - `:has-parent`: Must be IMMEDIATE parent
   - `:has-ancestor`: Any ancestor in chain, including immediate parent

5. **Position constraints are point-sensitive**: All procedures require knowing cursor position (byte offset) in buffer, not just current node.

### 8.3 Language-Specific Considerations

- **Python**: Always emit block nodes; use `_simple_statement` and `_compound_statement` supertypes heavily
- **TypeScript/JavaScript**: JSX elements require special handling; type annotations are first-class
- **CSS/HTML**: Simpler rules; focus on container/content relationships
- **JSON**: No procedures needed; trivial rule set

### 8.4 Testing Strategy

1. **Unit tests**: Rule expansion (all expansion types)
2. **Integration tests**: Trace through each example scenario
3. **Corpus tests**: Language-specific test procedures
4. **Edge cases**:
   - Point at node boundaries
   - Deeply nested structures
   - Recursive rules (exclude/all)
   - Multiple matching procedures (pick first)

---

## Part 9: Build-Time vs. Runtime

### 9.1 Build-Time Generation (combobulate-rules.el)

Current approach: Generate rule constants from `build-relationships.py`.

**For Rust**:
- Generate `rules.rs` module with const arrays/maps
- Or embed as JSON/YAML and parse at startup
- Or use proc-macro to inline at compile time

### 9.2 Runtime Registration

Languages register their procedures in their modules:

```elisp
(define-combobulate-language
 :name python
 :language python
 :major-modes (python-mode python-ts-mode)
 :custom combobulate-python-definitions)
```

**For Rust**:
- `HashMap<&'static str, LanguageConfig>`
- Each language provides procedures via registry
- Lookup by Tree-Sitter language name

---

## Part 10: Integration Points with Rust Replication

### 10.1 Required Interfaces

```rust
// Core interface
pub trait ProcedureEngine {
    fn apply(&self, procedure: &Procedure, node: &Node, point: usize) 
        -> Option<ProcedureResult>;
    fn apply_all(&self, node: &Node, point: usize, exhaustive: bool) 
        -> Vec<ProcedureResult>;
}

// Node interface (already exists in tree-sitter-rs)
pub trait NodeExt {
    fn field_count(&self) -> usize;
    fn field_name_for_child(&self, idx: usize) -> Option<&'static str>;
    fn child_by_field(&self, field_name: &str) -> Option<Node>;
    fn children_by_field(&self, field_name: &str) -> Vec<Node>;
}
```

### 10.2 Configuration

```rust
pub struct LanguageConfig {
    pub language: &'static str,
    pub rules: &'static ProductionRules,
    pub inverse_rules: &'static ProductionRules,
    pub all_types: &'static [&'static str],
    pub supertypes: &'static [&'static str],
    pub default_procedures: Vec<Procedure>,
}
```

### 10.3 Existing Combobulate Integration

This DSL is used throughout combobulate for:

```
Navigation:
├─ Sibling movement (C-M-n / C-M-p)
├─ Parent movement (C-M-u / C-M-d)
└─ Sequence movement (M-n / M-p)

Editing:
├─ Drag (M-N / M-P)
├─ Clone (with DWIM selection)
├─ Splice (remove parent)
└─ Envelope (template wrapping)

Query:
├─ Text search with rules
└─ Node selection
```

All are driven by registered procedures.

---

## Appendices

### A: Building the Inverse Rules

For each language, generate inverse:

```python
inverse = {}
for node_type, rule in rules.items():
    # For each node type that can appear in rule
    for child_type in rule.unnamed + rule.fields.values():
        if child_type not in inverse:
            inverse[child_type] = []
        inverse[child_type].append(node_type)
```

### B: All Node Type Collection

```python
all_types = set(rules.keys())
# Merge in supertypes (synthetic nodes)
all_types.update(supertypes)
```

### C: DSL Precedence (if implementing macro syntax)

If parsing Lisp-like syntax:

```
(rule-rx PATTERN) > (rule RULE-NAME) > (rx PATTERN) > string
(exclude A B) > other operators
t / (all) > others
```

---

**End of Document**
