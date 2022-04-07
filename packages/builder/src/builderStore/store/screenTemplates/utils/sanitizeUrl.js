export default function (url) {
  return url
    .split("/")
    .map(part => {
      part = decodeURIComponent(part)

      // If parameter, then use as is
      if (!part.startsWith(":")) {
        part = encodeURIComponent(part)
      }

      return part.replace(/ /g, "-")
    })
    .join("/")
    .toLowerCase()
}
