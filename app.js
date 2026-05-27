// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, query, errorHandler } from 'mu';
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
        opts.headers = [];
    }
    opts.headers["User-Agent"] = "mu-musicbrainz-fetch-service/0 (gilles.coremans@redpencil.io)";
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
    fetchQueue.push(item)
    if (!running) {
        setTimeout(process, currentDelay);
    }
}

async function process() {
    let item = fetchQueue.shift();
    const uuid = item.uuid;
    const kind = item.kind;
    const batch = item.batch;

    console.log(`Fetching ${kind}/${uuid}, remaining queue length ${fetchQueue.length}`);

    let response = await muFetch(`https://musicbrainz.org/${kind}/${uuid}`);

    if (response.status != 200) {
        console.error(`MB request failed for ${kind}/${uuid} with ${response.status} ${response.error}`);
    } else {
        const store = batches[batch].store;
        await parseP(jlds, store, defaultGraph, "application/ld+json")
        if(kind == "artist") {
            // If this is the URI we're looking up
            if (uuid == batch) {
                // Fetch all its albums (release-groups)
                store.match(itemToUri(item), SCHEMA('album'), null, null)
                    .map(s => s.object.value)
                    .map(uriToItem)
                    .forEach(enqueue);
            }
            // Otherwise, skip
        } else if (kind == "release-group") {
            // Fetch all releases of this album
            store.match(itemToUri(item), SCHEMA('albumRelease'), null, null)
                .map(s => s.object.value)
                .map(uriToItem)
                .forEach(enqueue);
            // Fetch all the artists of this album
            store.match(itemToUri(item), SCHEMA('byArtist'), null, null)
                .map(s => s.object.value)
                .map(uriToItem)
                .forEach(enqueue);
        } else if (kind == "release") {
            // If this is the URI we're looking up
            if (uuid == batch) {
                // Fetch this release's release group (this should only return one triple, but we use match() and maps anyway)
                store.match(itemToUri(item), SCHEMA('releaseOf'), null, null)
                    .map(s => s.object.value)
                    .map(uriToItem)
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
            console.error(`Batch ${batch} has impossible ${batches[batch].jobs} jobs!`);
        } else {
            console.log(batches[batch].store.toNT());
        }
    }
    
    if (fetchQueue.length != 0) {
        setTimeout(process, currentDelay);
    } else {
        running = false;
    }
}

function uriToItem(uri) {
    const regex = /http:\/\/musicbrainz.org\/(?<kind>artist|recording|release|release-group)\/(?<uuid>[\w-]+)/;
    const matches = uri.match(regex);
    if (matches) {
        return {
            kind: matches.groups.kind,
            uuid: matches.groups.uuid
        };
    } else {
        return null;
    }
}

function itemToUri(item) {
    return MB(`${item.kind}/${item.uuid}`);
}

app.get('/', async function( req, res ) {
    let response = await muFetch("https://musicbrainz.org/artist/e58c654e-cde5-4fa2-a356-9204475a748e", { headers: new Headers({ "Accept": "application/ld+json" }) });
    let jld = await response.json();
    let jlds = JSON.stringify(jld)
    console.log(jld);

    let store = graph();
    await parseP(jlds, store, defaultGraph, "application/ld+json");
    console.log(store.toNT())
    let albums = store.match(null, RDF('type'), SCHEMA('MusicAlbum'), null);
    console.log(albums)
    let subjects = albums.map(s => s.subject.value);
    console.log(subjects)
    let items = subjects.map(uriToItem)
    console.log(items)
    res.send(items);
    
});

app.use(errorHandler);
