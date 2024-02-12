import ivm from "isolated-vm"
import bson from "bson"

import url from "url"
import crypto from "crypto"
import querystring from "querystring"

import { BundleType, loadBundle } from "../bundles"
import { VM } from "@budibase/types"

class ExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExecutionTimeoutError"
  }
}

class ModuleHandler {
  private modules: {
    import: string
    moduleKey: string
    module: ivm.Module
  }[] = []

  private generateRandomKey = () => `i${crypto.randomUUID().replace(/-/g, "")}`

  registerModule(module: ivm.Module, imports: string) {
    this.modules.push({
      moduleKey: this.generateRandomKey(),
      import: imports,
      module: module,
    })
  }

  generateImports() {
    return this.modules
      .map(m => `import ${m.import} from "${m.moduleKey}"`)
      .join(";")
  }

  getModule(key: string) {
    const module = this.modules.find(m => m.moduleKey === key)
    return module?.module
  }
}

export class IsolatedVM implements VM {
  private isolate: ivm.Isolate
  private vm: ivm.Context
  private jail: ivm.Reference
  private invocationTimeout: number
  private isolateAccumulatedTimeout?: number

  // By default the wrapper returns itself
  private codeWrapper: (code: string) => string = code => code

  private moduleHandler = new ModuleHandler()

  private readonly resultKey = "results"

  constructor({
    memoryLimit,
    invocationTimeout,
    isolateAccumulatedTimeout,
  }: {
    memoryLimit: number
    invocationTimeout: number
    isolateAccumulatedTimeout?: number
  }) {
    this.isolate = new ivm.Isolate({ memoryLimit })
    this.vm = this.isolate.createContextSync()
    this.jail = this.vm.global
    this.jail.setSync("global", this.jail.derefInto())

    this.addToContext({
      [this.resultKey]: { out: "" },
    })

    this.invocationTimeout = invocationTimeout
    this.isolateAccumulatedTimeout = isolateAccumulatedTimeout
  }

  withHelpers() {
    const urlModule = this.registerCallbacks({
      resolve: url.resolve,
      parse: url.parse,
    })

    const querystringModule = this.registerCallbacks({
      escape: querystring.escape,
    })

    this.addToContext({
      helpersStripProtocol: new ivm.Callback((str: string) => {
        var parsed = url.parse(str) as any
        parsed.protocol = ""
        return parsed.format()
      }),
    })

    const injectedRequire = `const require=function req(val) {
        switch (val) {
            case "url": return ${urlModule};
            case "querystring": return ${querystringModule};
        }
      }`
    const helpersSource = loadBundle(BundleType.HELPERS)
    const helpersModule = this.isolate.compileModuleSync(
      `${injectedRequire};${helpersSource}`
    )

    helpersModule.instantiateSync(this.vm, specifier => {
      if (specifier === "crypto") {
        const cryptoModule = this.registerCallbacks({
          randomUUID: crypto.randomUUID,
        })
        const module = this.isolate.compileModuleSync(
          `export default ${cryptoModule}`
        )
        module.instantiateSync(this.vm, specifier => {
          throw new Error(`No imports allowed. Required: ${specifier}`)
        })
        return module
      }
      throw new Error(`No imports allowed. Required: ${specifier}`)
    })

    this.moduleHandler.registerModule(helpersModule, "helpers")
    return this
  }

  withContext(context: Record<string, any>) {
    this.addToContext(context)

    return this
  }

  withParsingBson(data: any) {
    this.addToContext({
      bsonData: bson.BSON.serialize({ data }),
    })

    // If we need to parse bson, we follow the next steps:
    // 1. Serialise the data from potential BSON to buffer before passing it to the isolate
    // 2. Deserialise the data within the isolate, to get the original data
    // 3. Process script
    // 4. Stringify the result in order to convert the result from BSON to json
    this.codeWrapper = code =>
      `(function(){
            const data = deserialize(bsonData, { validation: { utf8: false } }).data;
            const result = ${code}
            return toJson(result);
        })();`

    const bsonSource = loadBundle(BundleType.BSON)

    this.addToContext({
      textDecoderCb: new ivm.Callback(
        (args: {
          constructorArgs: any
          functionArgs: Parameters<InstanceType<typeof TextDecoder>["decode"]>
        }) => {
          const result = new TextDecoder(...args.constructorArgs).decode(
            ...args.functionArgs
          )
          return result
        }
      ),
    })

    // "Polyfilling" text decoder. `bson.deserialize` requires decoding. We are creating a bridge function so we don't need to inject the full library
    const textDecoderPolyfill = class TextDecoder {
      constructorArgs

      constructor(...constructorArgs: any) {
        this.constructorArgs = constructorArgs
      }

      decode(...input: any) {
        // @ts-ignore
        return textDecoderCb({
          constructorArgs: this.constructorArgs,
          functionArgs: input,
        })
      }
    }.toString()
    const bsonModule = this.isolate.compileModuleSync(
      `${textDecoderPolyfill};${bsonSource}`
    )
    bsonModule.instantiateSync(this.vm, specifier => {
      throw new Error(`No imports allowed. Required: ${specifier}`)
    })

    this.moduleHandler.registerModule(bsonModule, "{deserialize, toJson}")

    return this
  }

  execute(code: string): any {
    if (this.isolateAccumulatedTimeout) {
      const cpuMs = Number(this.isolate.cpuTime) / 1e6
      if (cpuMs > this.isolateAccumulatedTimeout) {
        throw new ExecutionTimeoutError(
          `CPU time limit exceeded (${cpuMs}ms > ${this.isolateAccumulatedTimeout}ms)`
        )
      }
    }

    code = `(1,eval)(\`${this.moduleHandler.generateImports()};results.out=${this.codeWrapper(
      code
    )}\`)`

    const script = this.isolate.compileModuleSync(code)

    script.instantiateSync(this.vm, specifier => {
      const module = this.moduleHandler.getModule(specifier)
      if (module) {
        return module
      }

      throw new Error(`"${specifier}" import not allowed`)
    })

    script.evaluateSync({ timeout: this.invocationTimeout })

    const result = this.getFromContext(this.resultKey)
    return result.out
  }

  private registerCallbacks(functions: Record<string, any>) {
    const libId = crypto.randomUUID().replace(/-/g, "")

    const x: Record<string, string> = {}
    for (const [funcName, func] of Object.entries(functions)) {
      const key = `f${libId}${funcName}cb`
      x[funcName] = key

      this.addToContext({
        [key]: new ivm.Callback((...params: any[]) => (func as any)(...params)),
      })
    }

    const mod =
      `{` +
      Object.entries(x)
        .map(([key, func]) => `${key}: ${func}`)
        .join() +
      "}"
    return mod
  }

  private addToContext(context: Record<string, any>) {
    for (let key in context) {
      const value = context[key]
      this.jail.setSync(
        key,
        typeof value === "function"
          ? value
          : new ivm.ExternalCopy(value).copyInto({ release: true })
      )
    }
  }

  private getFromContext(key: string) {
    const ref = this.vm.global.getSync(key, { reference: true })
    const result = ref.copySync()
    ref.release()
    return result
  }
}
