import { initReelsLibrary } from "./reels-view.js";
import { initReelsPipeline } from "./reels-pipeline.js";

const library = initReelsLibrary();
initReelsPipeline(async (id) => (await library).reload(id));
