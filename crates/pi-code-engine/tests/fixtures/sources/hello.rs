pub fn greet(name: &str) -> String { format!("Hello, {}!", name) }

pub struct Greeter { name: String }

impl Greeter { pub fn new(name: String) -> Self { Self { name } } pub fn greet(&self) -> String { greet(&self.name) } }
