let apiUrl = import.meta.env.VITE_BACKSTITCH_API_URL

if (apiUrl == undefined || "") {
    console.error("API URL must be defined by setting VITE_BACKSTITCH_API_URL in the `npm build` command!");
    apiUrl = "/api";
}

// https://stackoverflow.com/questions/29855098/is-there-a-built-in-javascript-function-similar-to-os-path-join/
function pathJoin(parts){
    const separator = '/';
    parts = parts.map((part, index)=>{
        if (index) {
            part = part.replace(new RegExp('^' + separator), '');
        }
        if (index !== parts.length - 1) {
            part = part.replace(new RegExp(separator + '$'), '');
        }
        return part;
    })
    return parts.join(separator);
 }

export { apiUrl, pathJoin }