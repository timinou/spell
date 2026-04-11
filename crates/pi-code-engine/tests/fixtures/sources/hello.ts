export function greet(name: string): string { return `Hello, ${name}!`; }

class Greeter { name: string; constructor(name: string) { this.name = name; } greet() { return greet(this.name); } }
