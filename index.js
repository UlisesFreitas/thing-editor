/*global require */
/*global __dirname */
/*global process */
/*global Buffer */

const log = console.log;
let bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
const open = require('open');
const AnsiToHtml = require('ansi-to-html');
const AnsiToHtmlConverter = new AnsiToHtml({bg: '#FFF', fg: '#000', newline: true});
const crypto = require('crypto');

function requireUncached(m) {
	delete require.cache[require.resolve(m)];
	return require(m);
}

process.chdir(path.resolve(__dirname, '..'));

const {
	exec
} = require('child_process');

const buildSounds = require('./scripts/build-sounds.js');

let currentGame;
let currentGameDesc;
let currentGameRoot;
let fullRoot = path.join(__dirname, '../');
let assetsMap = new Map();

let PORT = 32023;
let gamesRoot = 'games';
let jsonParser = bodyParser.json({limit: 1024 * 1024 * 200});
let rawParser = bodyParser.raw({limit: 1024 * 1024 * 200});

//========= File System access commands ====================

app.get('/fs/projects', function (req, res) {
	res.send(enumProjects());
});

app.get('/fs/openProject', function (req, res) {
	if(chromeConnectTimeout) {
		clearTimeout(chromeConnectTimeout);
		chromeConnectTimeout = null;
	}
	let folder = path.join(gamesRoot, req.query.dir, '/');
	let descPath = path.join(folder, 'thing-project.json');
	if(fs.existsSync(descPath)) {
		res.set('Set-Cookie', 'isThingEditor=1; Path=/; Expires=Thu, 31 Oct 2999 00:00:00 GMT;');
		currentGame = req.query.dir;
		currentGameRoot = folder;
		let projectDescSrc = fs.readFileSync(descPath);
		currentGameDesc = JSON.parse(projectDescSrc);

		if(!buildProjectAndExit) {
			try {
				initWatchers();
			} catch(err) {
				console.error('WATCHING ERROR:');
				console.error(err);
			}
		}
		res.send(projectDescSrc);
		excludeAnotherProjectsFromCodeEditor();
		applyProjectTypings();
		require('./scripts/pixi-typings-patch.js')(currentGameRoot);
	} else {
		log('Can\'t open project: ' + descPath);
		res.send('false');
	}
});

app.get('/fs/enum', function (req, res) {
	res.send(enumFiles());
});

const backupsFilter = {};

app.get('/fs/delete', function (req, res) {
	if(!currentGame) throw 'No game opened';
	let fn = mapFileUrl(req.query.f);
	let backup = req.query.backup;
	if(!fs.existsSync(fn)) {
		throw 'File does not exists ' + fn;
	}
	attemptFSOperation(() => {
		ignoreFileChanging(fn);
		if(backup) {
			let fileSize = fs.statSync(fn).size;
			if(backupsFilter[fn] !== fileSize) {
				let dir = path.dirname(fn);
				let deleteOlder = Date.now() - 1000 * 60 * 60 * 24 * 2;
				for(let file of fs.readdirSync(dir)) {
					if(file.startsWith('~deleted')) {
						let fullPath = path.join(dir, file);
						let stats = fs.statSync(fullPath);
						if(stats.ctimeMs < deleteOlder) {
							fs.unlinkSync(fullPath);
						}
					}
				}
				let historyName = path.join(dir, '~deleted(' + path.basename(fn) + ')' + new Date().toUTCString().replace(/[\W]/gm, '_') + '.log');
				fs.renameSync(fn, historyName);
				backupsFilter[fn] = fileSize;
				return;
			}
		}
		fs.unlinkSync(fn);
	}).then(() => {
		res.end('{}');
	}).catch(() => {
		res.end(JSON.stringify({error: 'Can not delete file: ' + fn}));
	});
});

app.get('/fs/edit', function (req, res) {
	if(buildProjectAndExit) {
		return;
	}
	if(!currentGame) throw 'No game opened';

	let fn = mapFileUrl(req.query.f);
	let line = req.query.l;
	let char = req.query.c;
	if(!fn.startsWith(fullRoot)) {
		fn = path.join(fullRoot, fn);
	}

	setTimeout(() => {
		try {
			open(fn);
			if(line && fs.lstatSync(fn).isFile()) {
				let arg = fn + ':' + line + (char ? ':' + char : '');
				open('', {app: ['code', '-r', '-g', arg]});
			}
			res.end('{}');
		} catch(err) {
			res.end(JSON.stringify({error: 'Can not open file to edit: ' + fn}));
		}
	}, 1);
});

app.post('/fs/fetch', jsonParser, function (req, res) {


	let fetch = require('node-fetch');
	fetch(req.body.url, req.body.options)
		.then((response) => {
			res.set('digest', response.headers.get('digest'));
			return response.text();
		})
		.then((data) => {
			if(typeof data !== 'string') {
				data = JSON.stringify(data);
			}
			res.end(data);
		}).catch((err) => {
			console.error(err);
			res.status(500).send("Thing-editor proxy fetch fails with result: " + JSON.stringify(err));
		});
});

app.get('/fs/build', function (req, res) {
	if(buildAndExitTimeout) {
		clearTimeout(buildAndExitTimeout);
		buildAndExitTimeout = null;
	}
	log('BUILD project' + (req.query.debug ? ' (debug)' : '') + ': ' + currentGameRoot + '; ' + (new Date()).toString());
	wss.showSpinner();
	let command = 'node "' +
		path.join(__dirname, 'scripts/build.js') + '" "' +
		currentGameRoot + '" ' +
		(req.query.debug ? 'debug' : '');
	command = command.replace(pathSeparatorReplaceExp, '/');
	exec(command,
		{maxBuffer: 1024 * 5000},
		(err, stdOut, errOut) => {
			log(errOut);
			if(stdOut instanceof Buffer) {
				stdOut = stdOut.toString();
			}
			let output = `${err ? `ERROR: ${JSON.stringify(err.stack || err)}\n` : ''}${stdOut || ''}`;
			res.end(JSON.stringify({
				isSuccess: Boolean(!err && output.indexOf('BUILD FAILED!') === -1),
				output: AnsiToHtmlConverter.toHtml(output),
			}));
			wss.hideSpinner();
		});
});

app.post('/fs/build-sounds', jsonParser, function (req, res) {
	if(buildSoundsTimeout) {
		clearTimeout(buildSoundsTimeout);
		buildSoundsTimeout = null;
	}
	log('BUILD sounds: ' + currentGameRoot);
	let fullResult = {};

	let foldersToProcess = ([currentGameRoot].concat((currentGameDesc.libs || []).map(getLibRoot)));

	const processOneFolder = () => {
		if(foldersToProcess.length > 0) {
			let folderName = foldersToProcess.shift();
			buildSounds(folderName, req.body).then(function (result) {
				for(let key of Object.keys(result)) {
					fullResult[key] = fullResult[key] || result[key];
				}
				processOneFolder();
			});
		} else {
			if(buildProjectAndExit) {
				buildAndExitTimeout = setTimeout(() => {
					console.error('ERROR: chrome have not call build command. Exit');
					process.exit(1);
				}, 2500000);
			}
			res.end(JSON.stringify(fullResult));
		}
	};
	processOneFolder();
});

app.post('/fs/exec', jsonParser, function (req, res) {
	let fileName = mapFileUrl('/' + gamesRoot + '/' + currentGame + '/' + req.body.filename);
	let m = requireUncached(path.join(__dirname, '..', fileName));
	m.main(function (err) {
		if(err) {
			throw err;
		}
		res.end();
	}, currentGameDesc, currentGameRoot, wss);
});

app.post('/fs/copyAssetToProject', rawParser, function (req, res) {
	let from = mapFileUrl(req.query.filename);
	let to = path.join(__dirname, '..', req.query.filename);
	ensureDirectoryExistence(to);
	attemptFSOperation(() => {
		ignoreFileChanging(to);
		fs.copyFileSync(from, to);
	}).then(() => {
		res.end('{}');
	}).catch(() => {
		res.end(JSON.stringify({error: 'Can not copy file from "' + from + '" to "' + to + '"'}));
	});
});

app.post('/fs/savefile', rawParser, function (req, res) {
	let fileName = mapFileUrl(req.query.filename);
	ensureDirectoryExistence(fileName);
	attemptFSOperation(() => {
		ignoreFileChanging(fileName);
		fs.writeFileSync(fileName, req.body);
	}).then(() => {
		res.end('{}');
	}).catch(() => {
		res.end(JSON.stringify({error: 'Can not save file: ' + fileName}));
	});
});

app.use('/', (req, res, next) => {
	if(!req.path.startsWith('/node_modules/')) {
		absoluteImportsFixer(path.join(__dirname, '..', decodeURIComponent(req.path)), req, res, next);
	} else {
		next();
	}
});

app.use('/games/', (req, res) => {
	let fileName = path.join(fullRoot, mapAssetUrl(decodeURIComponent(req.path)));
	if(fs.existsSync(fileName)) {
		res.setHeader('Cache-Control', 'no-store');
		attemptFSOperation(() => {
			fs.accessSync(fileName, fs.constants.R_OK);
			res.sendFile(fileName, {dotfiles: 'allow'});
		}).catch(() => {
			res.sendStatus(505);
		});
	} else {
		res.sendStatus(404);
	}
});

function mapFileUrl(url) {
	if(!url.startsWith('/games')) {
		url = path.join(__dirname, '..', url);
		return url;
	}
	let fileName = url.replace('/games', '');
	if(assetsMap.has(fileName)) {
		return assetsMap.get(fileName);
	} else {
		return path.join(fullRoot, url);
	}
}

function mapAssetUrl(url) {
	let fileName = url.split('?')[0];
	if(assetsMap.has(fileName)) {
		return assetsMap.get(fileName);
	} else {
		return '/games' + url;
	}
}


//=========== parse arguments ============================================================
let openChrome = true;
let buildProjectAndExit;
let editorArgumentsArray = [];
let editorArguments = {};
let params = process.argv.slice(2);
while(params.length) {
	let arg = params.shift();
	switch(arg) {
		case 'n':
			openChrome = false;
			break;
		case 'build':
			buildProjectAndExit = {
				projectName: params.shift()
			};
			process.env.buildProjectAndExit = buildProjectAndExit;
			break;
		case 'node_modules_path':
			var modulesPath = params.shift();
			if(!path.isAbsolute(modulesPath)) {
				modulesPath = path.join(__dirname, modulesPath);
			}
			if(fs.existsSync(modulesPath)) {
				app.use('/node_modules/', express.static(modulesPath, {dotfiles: 'allow'}));
			} else {
				console.warn('WARNING: node_modules_path points to not existing folder: ' + modulesPath);
			}
	}
	editorArgumentsArray.push(arg);
	editorArguments[arg] = true;
}

app.use('/', express.static(path.join(__dirname, '../'), {dotfiles: 'allow'}));

//========= start server ================================================================
let server = app.listen(PORT, () => log('Thing-editor listening on: http://127.0.0.1:' + PORT + '/thing-editor')); // eslint-disable-line no-unused-vars
server.timeout = 10000000;
let wss = require('./scripts/server-socket.js');
let chromeConnectTimeout;
let buildAndExitTimeout;
let buildSoundsTimeout;
if(openChrome) {

	let editorURL = 'http://127.0.0.1:' + PORT + '/thing-editor';
	if(buildProjectAndExit) {
		editorURL += '?buildProjectAndExit=' + encodeURIComponent(JSON.stringify(buildProjectAndExit));
		chromeConnectTimeout = setTimeout(() => {
			console.error('ERROR: chrome connection timeout.');
			process.exit(1);
		}, 15000);

		buildSoundsTimeout = setTimeout(() => {
			console.error('ERROR: chrome have not call build SOUNDS command.');
			process.exit(1);
		}, 40000);
	}
	if(editorArgumentsArray.length) {
		editorURL += '#' + editorArgumentsArray.join(',');
	}
	const os = require('os');
	let app = buildProjectAndExit ? [
		'--no-sandbox',
		'--headless',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--js-flags="--max_old_space_size=8192"',
		'--remote-debugging-port=' + (PORT + 2),
		'--user-data-dir=' + path.join(os.tmpdir(), 'chrome-user-tmp-data')
	] : ['--app=' + editorURL];

	app.unshift((process.platform == 'darwin') && 'Google Chrome' ||
		(process.platform == 'win32') && 'chrome' ||
		'google-chrome');

	open(editorURL, {app});
}

//=========== enum files ================================
let pathSeparatorReplaceExp = /\\/g;
let pathSeparatorReplace = (stat) => {
	stat.name = stat.name.replace(pathSeparatorReplaceExp, '/');
};

function getLibRoot(libName) {
	if(libName.startsWith('.')) {
		return path.join(currentGameRoot, libName);
	}
	return path.join(__dirname, '..', libName);
}

const ASSETS_FOLDERS_NAMES = ['snd', 'img', 'src/scenes', 'src/game-objects', 'scenes', 'prefabs', 'scripts', 'i18n'];
function getDataFolders(existingOnly = true) {
	let ret = [];
	if(currentGameDesc.libs) {
		for(let libName of currentGameDesc.libs) {
			let libRootFolder = getLibRoot(libName);
			if(fs.existsSync(libRootFolder)) {
				for(let type of ASSETS_FOLDERS_NAMES) {
					let assetsFolder = path.join(libRootFolder, type);
					if(fs.existsSync(assetsFolder)) {

						let libPath = libName.startsWith('.') ? path.join(currentGameRoot, libName, type) : path.join(libName, type);
						ret.push({
							type,
							path: libPath,
							lib: libName
						});
					}
				}
			} else {
				throw new Error("library folder '" + libName + "' not found.");
			}
		}
	}

	ASSETS_FOLDERS_NAMES.forEach((type) => {
		const typePath = path.join(currentGameRoot, type);
		if(!existingOnly || fs.existsSync(typePath)) {
			ret.push({type, path: typePath});
		}
	});

	return ret;
}

function readJOSNSync(fileName) {
	try {
		return JSON.parse(fs.readFileSync(fileName));
	} catch(er) {
		console.error('JSON READING ERROR: ' + fileName);
		console.error(er.stack);
	}
}

const filesToEnumFilter = /\.(js|json|xml|atlas|png|jpg|webp|svg|wav|mp3|ogg|aac|weba)$/;

let lastFilesEnum;

function enumFiles() {
	if(!currentGame) throw 'No game opened';
	let ret = {};

	assetsMap = new Map();

	let gameURL = '/' + currentGame + '/';

	let folders = getDataFolders(false);
	folders.reverse();
	var sameFiles;
	for(let f of folders) {
		let type = f.type;
		if(!ret[type]) {
			ret[type] = [];
		}
		let a = [];

		if(fs.existsSync(f.path)) {
			walkSync(f.path, a);
		}
		a = a.filter((fileData) => {

			if(fileData.name.match(filesToEnumFilter)) {

				pathSeparatorReplace(fileData);

				if(f.lib) {
					fileData.lib = f.lib;
				}
				let assetName = fileData.name.substr(f.path.length - type.length);
				let assetURL = gameURL + assetName;
				if(!type.startsWith('src')) {
					if(!assetsMap.has(assetURL)) {
						assetsMap.set(assetURL, fileData.name);
						fileData.name = assetName;
					} else {
						if(!assetURL.startsWith('/' + currentGame + '/snd/') || assetURL.endsWith('.wav')) {
							if(getFileHash(path.join(fullRoot, mapAssetUrl(assetURL))) === getFileHash(path.join(fullRoot, fileData.name))) {
								sameFiles = sameFiles || [];
								sameFiles.push({assetName, overlaps: fileData.name});
							}
						}
						return false;
					}
				}
				return true;
			}
		});
		ret[type] = ret[type].concat(a);
	}

	if(currentGameDesc.libs) {
		for(let libName of currentGameDesc.libs) {
			let libSettingsFilename = path.join(getLibRoot(libName), 'settings.json');
			if(fs.existsSync(libSettingsFilename)) {
				let folderSettings;
				let imagesSettings;
				if(ret.libsSettings) {
					folderSettings = ret.libsSettings.__loadOnDemandTexturesFolders;
					imagesSettings = ret.libsSettings.loadOnDemandTextures;
				}
				ret.libsSettings = Object.assign(ret.libsSettings || {}, readJOSNSync(libSettingsFilename));
				if(folderSettings) {
					ret.libsSettings.__loadOnDemandTexturesFolders = Object.assign(folderSettings, ret.libsSettings.__loadOnDemandTexturesFolders);
				}
				if(imagesSettings) {
					ret.libsSettings.loadOnDemandTextures = Object.assign(imagesSettings, ret.libsSettings.loadOnDemandTextures);
				}
			}
		}
	}
	lastFilesEnum = ret;
	if(sameFiles) {
		wss.sameFiles(sameFiles);
	}
	return ret;
}

function attemptFSOperation(cb) {
	let timeout = 20;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			try {
				cb();
				resolve();
			} catch(er) {
				if(timeout-- > 0) {
					setTimeout(attempt, 1000);
				} else {
					reject();
				}
			}
		};
		attempt();
	});
}

const walkSync = (dir, fileList = []) => {
	fs.readdirSync(dir).forEach(file => {
		if(!file.startsWith('~')) {
			let fullPath = path.join(dir, file);
			let stats = fs.statSync(fullPath);
			if(stats.isDirectory()) {
				fileList = walkSync(fullPath, fileList);
			} else if(stats.size > 0) {
				fileList.push({name: fullPath, mtime: stats.mtimeMs});
			}
		}
	});
	return fileList;
};

//============= enum projects ===========================
const enumProjects = (ret = [], subDir = '') => {
	let dir = path.join(__dirname, '..', gamesRoot, subDir);
	fs.readdirSync(dir).forEach(file => {
		if(file !== '.git' && file !== 'node_modules') {
			let dirName = path.join(dir, file);
			if(fs.statSync(dirName).isDirectory()) {
				let projDescFile = dirName + '/thing-project.json';
				if(fs.existsSync(projDescFile)) {
					let desc = readJOSNSync(projDescFile);
					desc.dir = subDir ? (subDir + '/' + file) : file;
					ret.push(desc);
				} else {
					enumProjects(ret, subDir ? (subDir + '/' + file) : file);
				}
			}
		}
	});
	return ret;
};

//============= enum libs ===========================
const enumLibs = (ret = [], dir = '.') => {
	fs.readdirSync(dir).forEach(file => {
		if(file !== '.git' && file !== 'node_modules') {
			let dirName = path.join(dir, file);
			if(fs.statSync(dirName).isDirectory()) {
				let libDescFile = path.join(dirName, '/thing-lib.json');
				if(fs.existsSync(libDescFile)) {
					ret.push(dirName.replace(pathSeparatorReplaceExp, '/').replace('./', ''));
				}
				let projDescFile = path.join(dirName, '/thing-project.json');
				if(!fs.existsSync(projDescFile)) {
					enumLibs(ret, dirName);
				}
			}
		}
	});
	return ret;
};

//=============== create folder for file ==================
function ensureDirectoryExistence(filePath) {
	let dirname = path.dirname(filePath);
	if(fs.existsSync(dirname)) {
		return true;
	}
	ensureDirectoryExistence(dirname);
	fs.mkdirSync(dirname);
}

//=============== project's files changing watcher ================
let watchers = [];
let changedFiles = {};
let fileChangedTimeout;

const filesIgnore = {};

function ignoreFileChanging(fileName) {
	fileName = path.resolve(fileName);
	if(filesIgnore[fileName]) {
		clearTimeout(filesIgnore[fileName]);
	}
	filesIgnore[fileName] = setTimeout(() => {
		delete filesIgnore[fileName];
	}, 2000);
}

const filterWatchFiles = /\.(json|png|wav|jpg|js)$/mg;
function initWatchers() {

	let watchFolders = new Set();
	let foldersToWatch = getDataFolders();

	if(currentGameDesc.__externalTranslations) {
		currentGameDesc.__externalTranslations.forEach((src) => foldersToWatch.push({type: 'i18n', isExternalTranslationFile: true, path: path.join(__dirname, `../${src}`)}));
	}

	for(let w of watchers) {
		w.deleteIt = true;
	}

	for(let assetsFolderData of foldersToWatch) {
		let assetsFolder = assetsFolderData.type + '/';

		if(assetsFolderData.type === 'src/game-objects' || assetsFolderData.type === 'src/scenes') {
			assetsFolderData.path = assetsFolderData.path.replace(/src(\\|\/)(game-objects|scenes)$/, 'src');
			assetsFolder = 'src/';
		}
		if(!fs.existsSync(assetsFolderData.path) || watchFolders.has(assetsFolderData.path)) {
			continue;
		}
		watchFolders.add(assetsFolderData.path);

		// log('watch: ' + assetsFolderData.path);

		if(watchers.find((w) => {
			if(w.path === assetsFolderData.path) {
				w.deleteIt = false;
				return true;
			}
		})) {
			continue;
		}

		let watcher = fs.watch(assetsFolderData.path, {recursive: true});
		watcher.path = assetsFolderData.path;
		watchers.push(watcher);
		watcher.on('error', () => {
			console.log("Watcher error");
		});
		watcher.on('change', (eventType, filename) => {
			if(filename && filterWatchFiles.test(filename)) {

				filename = filename.replace(pathSeparatorReplaceExp, '/');
				// log('file changed event: ' + eventType + '; ' + filename);
				if(filename.indexOf('/~') >= 0) {
					return;
				}

				let fullFileName;
				if(assetsFolderData.isExternalTranslationFile) {
					fullFileName = assetsFolderData.path;
				} else {
					fullFileName = path.join(assetsFolderData.path, filename);
					filename = path.join(assetsFolder, filename);
				}

				if(filesIgnore[path.resolve(fullFileName)]) {
					return;
				}

				if(filename.startsWith('~') || (filename.indexOf('/~') >= 0) || (filename.indexOf('\\~') >= 0)) {
					return;
				}
				
				if(eventType === 'change' || eventType === 'rename') {
					setTimeout(() => {
						if(fs.existsSync(fullFileName)) {
							try {
								let stats = fs.statSync(fullFileName);
								if(stats.isFile() && stats.size > 0) {
									let existingFileDesc;
									if(lastFilesEnum) {
										let normalizedName = fullFileName.replace(pathSeparatorReplaceExp, '/');
										for(let i in lastFilesEnum) {
											i = lastFilesEnum[i];
											if(Array.isArray(i)) {
												existingFileDesc = i.find((a) => {
													return normalizedName.endsWith(a.name);
												});
												if(existingFileDesc) {
													break;
												}
											}
										}
										if(!existingFileDesc || (existingFileDesc.mtime !== stats.mtimeMs)) {
											if(assetsFolderData.isExternalTranslationFile) {
												filename = 'i18n/en.json'; // enforce textView to reload.
											}
											fileChangeSchedule(filename, stats.mtime);
										}
									}
								}
							} catch(er) {
								log("file change handler error: " + er); //for case if tmp file is not exist
							}
						} else {
							fileChangeSchedule(filename, 0, true);
						}
					}, 100);
				}
			}
		});
	}

	watchers = watchers.filter((w) => {
		if(w.deleteIt) {
			w.close();
			return false;
		}
		return true;
	});
}

function fileChangeSchedule(name, mtime, deleted = false) {
	changedFiles[name] = {name, mtime, deleted};
	if(fileChangedTimeout) {
		clearTimeout(fileChangedTimeout);
	}
	fileChangedTimeout = setTimeout(filesChangedProcess, 500);
}

function filesChangedProcess() {
	fileChangedTimeout = null;
	let files = [];
	for(let fileName in changedFiles) {
		let s = changedFiles[fileName];
		pathSeparatorReplace(s);
		log('file changed: ' + fileName);
		files.push(s);
	}
	wss.filesChanged(files);
	changedFiles = {};
}

//=============== vs-code integration ==================

function excludeAnotherProjectsFromCodeEditor() { // hides another projects from vs code
	if(editorArguments['no-vscode-integration']) {
		return;
	}

	let jsConfigFN = './jsconfig.json';
	let vsSettingsFn = './.vscode/settings.json';

	let dirsToExclude = enumProjects().filter(g => g.dir !== currentGame).map(p => 'games/' + p.dir).concat(enumLibs([]).filter(isLibNotInProject));

	if(fs.existsSync(jsConfigFN)) {
		let jsConfig = readJOSNSync(jsConfigFN);
		let oldJsExcludes = jsConfig.exclude;
		let exclude = [];
		jsConfig.exclude = exclude;
		if(Array.isArray(oldJsExcludes)) {
			for(let k of oldJsExcludes) {
				if(!isLibInProject(k)) {
					exclude.push(k);
				}
			}
		}
		for(let dir of dirsToExclude) {
			if(!isLibInProject(dir) && (exclude.indexOf(dir) < 0)) {
				exclude.push(dir);
			}
		}
		fs.writeFileSync(jsConfigFN, JSON.stringify(jsConfig, undefined, '	'));
	}

	if(fs.existsSync(vsSettingsFn)) {
		let config = readJOSNSync(vsSettingsFn);
		let oldExcludes = config['files.exclude'];
		let exclude = {};
		config['files.exclude'] = exclude;
		if(oldExcludes) {
			for(let k in oldExcludes) {
				if(!isLibInProject(k.replace(/(^\*\*\/|\/\*\*$)/gm, ''))) {
					exclude[k] = oldExcludes[k];
				}
			}
		}
		for(let dir of dirsToExclude) {
			exclude['**/' + dir + '/**'] = true;
		}
		fs.writeFileSync(vsSettingsFn, JSON.stringify(config, undefined, '	'));
	}

	jsConfigFN = '../' + jsConfigFN;
	vsSettingsFn = '../' + vsSettingsFn;

}

function isLibNotInProject(libName) {
	return !isLibInProject(libName);
}

function isLibInProject(libName) {
	return (currentGameDesc.libs && (currentGameDesc.libs.findIndex((f) => {
		if(f.startsWith('.')) {
			f = path.join('games', currentGame, f).replace(/\\/mg, '/');
		}
		return f.startsWith(libName);
	}) >= 0)) || (libName === ('games/' + currentGame));
}

function applyProjectTypings() {
	if(editorArguments['no-vscode-integration']) {
		return;
	}
	let typings = [];
	const typingsPath = path.join(__dirname, '../current-project-typings.js');
	if(currentGameDesc.libs) {
		for(let libName of currentGameDesc.libs) {
			let libTypings = path.join(getLibRoot(libName), 'typings.js');
			if(fs.existsSync(libTypings)) {
				typings.push(fs.readFileSync(libTypings, 'utf8'));
			}
		}
	}
	let gameTypingsPath = path.join(currentGameRoot, 'typings.js');
	if(fs.existsSync(gameTypingsPath)) {
		typings.push(fs.readFileSync(gameTypingsPath, 'utf8'));
	}
	if(typings.length > 0) {
		fs.writeFileSync(typingsPath, `// thing-editor auto generated file.
export default null;

` + typings.join('\n'));
	} else {
		if(fs.existsSync(typingsPath)) {
			fs.unlinkSync(typingsPath);
		}
	}
}

//=============== module importing fixer ==================

let moduleImportFixer = /(^\s*import.+from\s*['"][^'"]+)(['"])/gm;

let moduleImportAbsFixer = /(^\s*import.+from\s*['"])([^.\/])/gm;
let moduleEmptyImportAbsFixer = /(^\s*import\s*['"])([^.\/])/gm;

function absoluteImportsFixer(fileName, req, res, next) {
	let needParse = req.path.endsWith('.js') && !req.path.endsWith('.min.js');
	if(needParse) {
		fs.readFile(fileName, function (err, content) {
			if(err) {
				console.error('JS PREPROCESSING ERROR: ' + err);
				next(err);
			} else {
				res.set('Content-Type', 'application/javascript');
				let resultJsContent = content.toString().replace(moduleImportAbsFixer, (substr, m1, m2) => {
					return m1 + "/" + m2;
				});
				resultJsContent = resultJsContent.replace(moduleEmptyImportAbsFixer, (substr, m1, m2) => {
					return m1 + "/" + m2;
				});
				resultJsContent = addJsExtensionAndPreventCache(req, res, resultJsContent);
				resultJsContent = resultJsContent.replace(/\/\*ts\*\//g, '/*ts  ').replace(/\/\*\/ts\*\//g, '   ts*/');
				return res.end(resultJsContent);
			}
		});
	} else {
		next();
	}
}

function addJsExtensionAndPreventCache(req, res, content) {
	let modulesVersion = req.query ? req.query.v : false;
	if(modulesVersion) {
		res.set('Content-Type', 'application/javascript');
		content = content.toString().replace(moduleImportFixer, (substr, m1, m2) => {
			if(!m1.toLowerCase().endsWith('.js')) {
				m1 += '.js';
			}
			if(m1.indexOf('thing-editor/') >= 0) {
				return m1 + m2;
			}
			return m1 + '?v=' + modulesVersion + m2;
		});
	}
	return content;
}

function getFileHash(fileName) {
	const fileBuffer = fs.readFileSync(fileName);
	const hashSum = crypto.createHash('sha256');
	hashSum.update(fileBuffer);
	return hashSum.digest('hex');
}