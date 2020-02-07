import { createApp } from "./createApp"
import { trimSlash } from "./common/trimSlash"
import { builtins, builtinLibName } from "./render/builtinComponents"

export const loadBudibase = async ({
  componentLibraries,
  page,
  screens,
  window,
  localStorage,
  uiFunctions,
}) => {
  const appDefinition = window["##BUDIBASE_APPDEFINITION##"]
  const uiFunctionsFromWindow = window["##BUDIBASE_APPDEFINITION##"]
  uiFunctions = uiFunctionsFromWindow || uiFunctions

  const userFromStorage = localStorage.getItem("budibase:user")

  const user = userFromStorage
    ? JSON.parse(userFromStorage)
    : {
        name: "annonymous",
        permissions: [],
        isUser: false,
        temp: false,
      }

  const rootPath =
    appDefinition.appRootPath === ""
      ? ""
      : "/" + trimSlash(appDefinition.appRootPath)

  if (!componentLibraries) {
    
    const componentLibraryUrl = lib => rootPath + "/" + trimSlash(lib)
    componentLibraries = {}

    for (let lib of appDefinition.componentLibraries) {
      componentLibraries[lib.libName] = await import(
        componentLibraryUrl(lib.importPath)
      )
    }
  }

  componentLibraries[builtinLibName] = builtins(window)

  if (!page) {
    page = appDefinition.page
  }

  if (!screens) {
    screens = appDefinition.screens
  }

  const initialisePage = createApp(
    window.document,
    componentLibraries,
    appDefinition,
    user,
    uiFunctions || {},
    screens
  )

  const route = window.location 
                ? window.location.pathname.replace(rootPath, "")
                : "";

  return initialisePage(page, window.document.body, route)
}

if (window) {
  window.loadBudibase = loadBudibase
}
