import { injectable } from "inversify";

@injectable()
export class Greeter {
  private greeting: string;

  constructor(message: string) {
    this.greeting = message;
  }

  public greet(): string {
    return `Hello, ${this.greeting}`;
  }
}

export const arrowGreet = (name: string): string => {
  return `Hi, ${name}`;
};
