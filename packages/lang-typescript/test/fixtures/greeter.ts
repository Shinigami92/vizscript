function greeter(person: string): string {
  return "Hello, " + person;
}

const user: string = "Jane User";

const textContent: string = greeter(user);

console.log(greeter(user));
