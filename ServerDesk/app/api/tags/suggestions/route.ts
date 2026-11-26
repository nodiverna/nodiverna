import {failure,requireViewer} from '@/lib/server/context';
import {tagSuggestions} from '@/lib/server/devices/tag-store';
const headers={'Cache-Control':'no-store'};
// Tag names and values for the input suggestions, only from objects the viewer may view (lib/server/devices/tag-store.ts).
export async function GET(){try{
 const v=await requireViewer();
 return Response.json(await tagSuggestions(v),{headers});
}catch(e){return failure(e);}}
