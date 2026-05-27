// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, update, errorHandler, beforeExit } from 'mu';
import bodyParser from 'body-parser';
import { Namespace, graph, parse, serialize } from 'rdflib';

const SCHEMA = Namespace("http://schema.org/");
const MB = Namespace("http://musicbrainz.org/")
const RDF = Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#")
const MU = Namespace("http://mu.semte.ch/vocabularies/core/")

const defaultGraph = "http://mu.semte.ch/graphs/public";

let fetchQueue = [];
let batches = {}; // mapping batchid -> {store, jobs, batchUri, fetched}
let currentDelay = 1000;
let running = false;

function muFetch(url, opts) {
    if (!opts) {
        opts = {};
    }
    if (!opts.headers) {
        opts.headers = new Headers();
    }
    opts.headers.set("User-Agent", "mu-musicbrainz-fetch-service/0 (gilles.coremans@redpencil.io)");
    opts.headers.set("Accept", "application/ld+json");
    return fetch(url, opts); // not async, we just return the promise directly
}

// promisify parse
function parseP(text, store, graph, mime) {
    return new Promise((resolve, reject) => {
        parse(text, store, graph, mime, (err, data) => {
            if (err != null) {
                reject(err);
            } else {
                resolve(data);
            }
        }) 
    });
}

function enqueue(item) {
    const batch = item.batch;
    if (!(batch in batches)) {
        batches[batch] = {
            batchUri: itemToUri(item),
            fetched: [item.uuid], // dont refetch things we've already fetched
            store: graph(),
            jobs: 1
        };
    } else {
        // If we've already queued this, don't queue it again
        if (batches[batch].fetched.includes(item.uuid)) {
            return;
        }
        batches[batch].jobs += 1;
        batches[batch].fetched.push(item.uuid);
    }
    console.log(`Pushing ${item.kind}/${item.uuid} to queue`);
    fetchQueue.push(item)
    if (!running) {
        console.log("Starting processing");
        running = true;
        setTimeout(process, currentDelay);
    }
}

async function process() {
    if (fetchQueue.length == 0) {
        console.log("Process called on empty queue!")
        running = false;
        return;
    }
    let item = fetchQueue.shift();
    const uuid = item.uuid;
    const kind = item.kind;
    const batch = item.batch;

    console.log(`Fetching ${kind}/${uuid}, remaining queue length ${fetchQueue.length}`);

    let response = await muFetch(`https://musicbrainz.org/${kind}/${uuid}`);
    let body = await response.text();

    if (response.status != 200) {
        console.log(`MB request failed for ${kind}/${uuid} with ${response.status} ${response.error}`);
        console.log(body);
    } else {
        const store = batches[batch].store;
        await parseP(body, store, defaultGraph, "application/ld+json")
        if(kind == "artist") {
            // If this is the URI we're looking up
            if (uuid == batch) {
                // Fetch all its albums (release-groups)
                store.match(itemToUri(item), SCHEMA('album'), null, null)
                    .map(s => uriToItem(s.object.value, batch))
                    .forEach(enqueue);
            }
            // Otherwise, skip
        } else if (kind == "release-group") {
            // Fetch all releases of this album
            store.match(itemToUri(item), SCHEMA('albumRelease'), null, null)
                .map(s => uriToItem(s.object.value, batch))
                .forEach(enqueue);
            // Fetch all the artists of this album
            store.match(itemToUri(item), SCHEMA('byArtist'), null, null)
                .map(s => uriToItem(s.object.value, batch))
                .forEach(enqueue);
        } else if (kind == "release") {
            // If this is the URI we're looking up
            if (uuid == batch) {
                // Fetch this release's release group (this should only return one triple, but we use match() and maps anyway)
                store.match(itemToUri(item), SCHEMA('releaseOf'), null, null)
                    .map(s => uriToItem(s.object.value, batch))
                    .forEach(enqueue);
            }
            // Else, skip
        }
        // Looking up recordings separately is pointless, since all their info comes along.
        // There is extra info (i.e. artist relationships) on recordings, but it is not exposed via the linked data API
        // else if (kind == "recording") {}
        
        console.log(`Finished fetching ${kind}/${uuid}, remaining queue length ${fetchQueue.length}`);
    }

    batches[batch].jobs -= 1;

    // If this was the last job in the batch, finish it and import it into the triplestore
    if (batches[batch].jobs <= 0) {
        if (batches[batch].jobs < 0) {
            console.error(`Batch ${batch} has impossible ${batches[batch].jobs} job count!`);
        } else {
            console.log(`Finishing batch ${batch} with ${batches[batch].fetched.length} fetches.`)
            const store = batches[batch].store;

            // Copy item UUIDs to mu:uuid
            const resources = [].concat(
                store.match(null, RDF('type'), SCHEMA('MusicGroup'), null),
                store.match(null, RDF('type'), SCHEMA('MusicAlbum'), null),
                store.match(null, RDF('type'), SCHEMA('MusicRelease'), null),
                store.match(null, RDF('type'), SCHEMA('MusicRecording'), null))
                .map(t => uriToItem(t.subject.value, null));
                
            resources.forEach(item => store.add(itemToUri(item), MU('uuid'), item.uuid, null));

            // Insert items into triplestore
            //const data = await serializeP(null, store, defaultGraph, "text/turtle", { flags: "p" });
            const data = store.match(null, null, null, null)
                .filter(t => t.subject.termType != "BlankNode" && t.object.termType != "BlankNode")
                .map(t => t.toNT());
            const sparqlData =
`
INSERT DATA {
    GRAPH <${defaultGraph}> {
        ${data.join("\n")}
    }
}
`
            await update(sparqlData);
            console.log(`Batch ${batch} finished. Added ${data.length} triples to the store.`);
        }
    }
    
    if (fetchQueue.length != 0) {
        setTimeout(process, currentDelay);
    } else {
        console.log("Processing finished.");
        running = false;
    }
}

function uriToItem(uri, batch) {
    const regex = /https?:\/\/musicbrainz.org\/(?<kind>artist|recording|release|release-group)\/(?<uuid>[\w-]+)/;
    const matches = uri.match(regex);
    if (matches) {
        return {
            kind: matches.groups.kind,
            uuid: matches.groups.uuid,
            batch: (batch ? (batch) : (matches.groups.uuid))
        };
    } else {
        return null;
    }
}

function itemToUri(item) {
    return MB(`${item.kind}/${item.uuid}`);
}

app.post('/fetch', bodyParser.json({ limit: '1mb' }), async function( req, res ) {
    const item = uriToItem(req.body.uri);
    enqueue(item);
    res.json(item);
});

app.get('/queue', async function( req, res ) {
    res.json(fetchQueue);
});

app.get('/batches', async function( req, res ) {
    res.json(batches);
});

app.use(errorHandler);
