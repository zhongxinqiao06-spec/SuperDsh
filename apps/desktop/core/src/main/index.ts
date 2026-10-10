/** The desktop's browser module is composed independently of the Harness Host capabilities. */
export const name = 'superdsh-desktop-client'

/** The Host face only declares the browser companion; native work belongs to Electron. */
export function apply(): void {}
