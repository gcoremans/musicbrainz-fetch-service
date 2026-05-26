// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, query, errorHandler } from 'mu';
import { Namespace, graph, parse, serialize } from 'rdflib';

const SCHEMA = Namespace("http://schema.org/");
const MB = Namespace("http://musicbrainz.org/")
const RDF = Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#")
const MU = Namespace("http://mu.semte.ch/vocabularies/core/")

const defaultGraph = "http://mu.semte.ch/graphs/public";

let fetchQueue = [];
let batches = {}; // mapping batchid -> {graph, jobs}
let currentDelay = 1000;
let running = false;

function muFetch(url, opts) {
    if (!opts) {
        opts = {};
    }
    if (!opts.headers) {
        opts.headers = [];
    }
    opts.headers["User-Agent"] = "mu-musicbrainz-fetch-service/0.0.0 (gilles.coremans@redpencil.io)";
    return fetch(url, opts);
}

function enqueue(item) {
    const batch = item.batch;
    if (!(batch in batches)) {
        batches[batch] = {
            graph: graph(),
            jobs: 1
        };
    } else {
        batches[batch].jobs += 1;
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

    let response = await muFetch(`https://musicbrainz.org/${kind}/${uuid}`);

    if (response.status != 200) {
        console.error(`MB request failed for ${kind}/${uuid} with ${response.status} ${response.error}`);
    } else {
        
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

app.get('/', async function( req, res ) {
    let response = await muFetch("https://musicbrainz.org/artist/e58c654e-cde5-4fa2-a356-9204475a748e", { headers: new Headers({ "Accept": "application/ld+json" }) });
    let jld = await response.json();
    let jlds = JSON.stringify(jld)
    console.log(jld);

    let store = graph();
    parse(jlds, store, defaultGraph, "application/ld+json", () => {
        console.log(store.toNT())
        let albums = store.match(null, RDF('type'), SCHEMA('MusicAlbum'), null);
        console.log(albums)
        let subjects = albums.map(s => s.subject.value);
        console.log(subjects)
        let items = subjects.map(uriToItem)
        console.log(items)
        res.send(items);
    });
    
});

app.use(errorHandler);
