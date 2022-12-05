import env from "../../../environment"
import { syncGlobalUsers } from "../../../api/controllers/user"
import { db as dbCore, context } from "@budibase/backend-core"

export async function syncApp(appId: string) {
  if (env.DISABLE_AUTO_PROD_APP_SYNC) {
    return {
      message:
        "App sync disabled. You can reenable with the DISABLE_AUTO_PROD_APP_SYNC environment variable.",
    }
  }

  if (!dbCore.isDevAppID(appId)) {
    throw new Error("This action cannot be performed for production apps")
  }

  // replicate prod to dev
  const prodAppId = dbCore.getProdAppID(appId)

  // specific case, want to make sure setup is skipped
  const prodDb = context.getProdAppDB({ skip_setup: true })
  const exists = await prodDb.exists()
  if (!exists) {
    // the database doesn't exist. Don't replicate
    return {
      message: "App sync not required, app not deployed.",
    }
  }

  const replication = new dbCore.Replication({
    source: prodAppId,
    target: appId,
  })
  let error
  try {
    await replication.replicate(replication.appReplicateOpts())
  } catch (err) {
    error = err
  } finally {
    await replication.close()
  }

  // sync the users
  await syncGlobalUsers()

  if (error) {
    throw error
  } else {
    return {
      message: "App sync completed successfully.",
    }
  }
}
