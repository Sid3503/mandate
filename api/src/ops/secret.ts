/** A secret that never prints. Logging the object yields `[redacted]`. Call `reveal` only at a comparison. */
export class SecretString {
  constructor(private readonly value: string) {}

  reveal(): string {
    return this.value
  }

  toString(): string {
    return '[redacted]'
  }

  toJSON(): string {
    return '[redacted]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]'
  }
}
