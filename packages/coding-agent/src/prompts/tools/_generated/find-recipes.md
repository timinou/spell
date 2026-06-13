## Qualifiers

|qualifier|applies to|args|
|---|---|---|
|#bytes|file|—|
|#captures|grep|N after [text~="(re)"]|
|#image|file|—|
|#lines|file|a..b|
|#listing|dir|—|
|#match|grep|after [text~="re"]|
|#outline|file|depth=N|
|#raw|file|—|
|#stat|file, dir|—|
|#text|file|—|
|#thumbnail|file|N|
|#tree|dir|depth=N|

## Edge kinds

|symbol|name|description|
|---|---|---|
|bind→|Bind|From a use to its binding site (scope-local)|
|call→|Call|From a call site to the callee|
|def→|Definition|From a declaration to its references (set-valued). Trailing `→` is sugar for `…def→§*`. Follows re-export chains.|
|dispatches→|Dispatches|From a polymorphic call site to candidate dispatch targets|
|implements→|Implements|From a type to the interface/trait it implements (TS `implements`, Rust `impl Trait for X`)|
|import→|Import|From an imported name to the source module|
|inherits→|Inherits|From a type to its base type (TS `extends`, Python `class X(Base)`)|
|ref→|Reference|Follow a reference to its definition|