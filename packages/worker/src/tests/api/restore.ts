import TestConfiguration from "../TestConfiguration"
import { TestAPI, TestAPIOpts } from "./base"

export class RestoreAPI extends TestAPI {
  constructor(config: TestConfiguration) {
    super(config)
  }

  restored = (opts?: TestAPIOpts) => {
    return this.request
      .post(`/api/system/restored`)
      .expect(opts?.status ? opts.status : 200)
  }
}
