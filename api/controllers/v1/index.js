const _ = require('lodash');
const router = require('express').Router();
const es = require('../../lib/es');
const suds = require('../../lib/services/suds');
const fastly = require('../../lib/services/fastly');
const contentApi = require('../../lib/services/content');


const vanityRegex = /^\/article\/+([0-9]+\/[0-9]+\/[0-9]+\/[0-9]+\/?.*)$/;
const uuidRegex = /^\/article\/+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const mlVanityRegex = /(^\/marketslive\/+[0-9]+\-[0-9]+\-[0-9]+-?[0-9]+?\/?)$/;
const mlUuidRegex = /^\/marketslive\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;


const KeenQuery = require('keen-query');

KeenQuery.setConfig({
  KEEN_PROJECT_ID: process.env.KEEN_PROJECT_ID,
  KEEN_READ_KEY: process.env.KEEN_READ_KEY,
  KEEN_HOST: 'https://keen-proxy.ft.com/3.0'
});

const getPopularArticles = () => new KeenQuery('page:view')
  .count()
  .group('page.location.pathname')
  .relTime('this_3_days')
  .filter('context.app=alphaville')
  .filter('user.subscriptions.isStaff!=true')
  .filter('page.location.pathname~/')
  .filter('page.location.pathname!=/')
  .filter('page.location.pathname!~/marketslive')
  .filter('page.location.pathname!~/search')
  .filter('page.location.pathname!~/uc_longroom')
  .filter('page.location.pathname!~/author')
  .filter('page.location.pathname!~/alphachat')
  .filter('page.location.pathname!~/meet-the-team')
  .filter('page.location.pathname!~/page')
  .print('json')
  .then(results => results.rows
    .map(([ pathname, count]) => ({ pathname, count }))
    .sort(({ count: countOne }, { count: countTwo }) => countTwo - countOne)
  );

const getMostCommentedArticles = () => new KeenQuery('comment:post')
  .count()
  .group('page.location.pathname')
  .relTime('this_3_days')
  .filter('context.app=alphaville')
  .filter('user.subscriptions.isStaff!=true')
  .filter('page.location.pathname~/')
  .filter('page.location.pathname!~/marketslive')
  .print('json')
  .then(results => results.rows
    .map(([ pathname, count]) => ({ pathname, count }))
    .sort(({ count: countOne }, { count: countTwo }) => countTwo - countOne)
  );

const getMostPopularTopic = () => new KeenQuery('page:view')
  .count()
  .group('page.location.pathname')
  .relTime('this_14_days')
  .filter('context.app=alphaville')
  .filter('user.subscriptions.isStaff!=true')
  .filter('page.location.pathname~/topic')
  .print('json')
  .then(results => results.rows
    .map(([ pathname, count]) => ({ pathname, count }))
    .sort(({ count: countOne }, { count: countTwo }) => countTwo - countOne)
  );


const KeenQueryPoller = require('../../lib/services/KeenQueryPoller');

const popularArticlesPoller = new KeenQueryPoller(getPopularArticles);
const mostCommentedArticlesPoller = new KeenQueryPoller(getMostCommentedArticles);
const mostPopularTopicPoller = new KeenQueryPoller(getMostPopularTopic);


const articleCache = 300;
const mlCacheShort = 60;
const mlCacheLong = 3600;
const indexStreamCache = 60;
const searchStreamCache = 60;
const authorStreamCache = 60;
const mlStreamCache = 60;
const hotStreamCache = 600;

const setCache = (res, value) => {
	if (process.env.NODE_ENV === 'production') {
		if (value > 0) {
			res.set('Surrogate-Control', 'max-age=' + value);
		} else {
			setNoCache(res);
		}
	} else {
		setNoCache(res);
	}
};

const setNoCache = (res) => {
	res.set('Cache-Control', 'private, no-cache, no-store');
};

const sanitizeParam = (param) => {
	return param.replace(/^\/+|\/+$/g, '');
};

const sanitizeSearchString = (str) => {
	return _.trim(str.replace(/\s*[":><=+|\-()]+\s*/g, ' '));
};

const getEsQueryForArticles = (req) => {
	const offset = parseInt(req.query.offset, 10) || 0;
	const limit = parseInt(req.query.limit, 10) || 30;
	return {
		sort: {
			initialPublishedDate: {
				order: 'desc'
			}
		},
		from: offset,
		size: limit
	};
};

router.use((req, res, next) => {
	if (process.env.API_KEY === req.get('X-API-KEY')) {
		return next();
	}
	res.sendStatus(401);
});

//articles
router.get('/articles', (req, res, next) => {
	let esQuery = getEsQueryForArticles(req);
	let searchString = req.query.q || null;
	let sanitizedSearchString = null;

	if (searchString) {
		sanitizedSearchString = sanitizeSearchString(searchString);
	}

	if (!sanitizedSearchString) {
		es.searchArticles(esQuery)
			.then(articles => {
				setCache(res, indexStreamCache);
				res.json(articles);
			})
			.catch(next);
	} else {
		if (sanitizedSearchString.length > process.env['SEARCH_MAX_LENGTH']) {
			return res.json({
				hits: {
					hits: []
				}
			});
		}
		const offset = parseInt(req.query.offset, 10) || 0;
		const limit = parseInt(req.query.limit, 10) || 30;
		let indexCount = 0;
		contentApi.search(sanitizedSearchString, limit, offset)
			.then(articles => {
				if (parseInt(articles.results[0].indexCount, 10)) {
					indexCount = articles.results[0].indexCount;
					return articles.results[0].results.map(a => a.id);
				}
			})
			.then(articlesIds => {
				if (articlesIds) {
					esQuery = {
						query: {
							ids: {
								values: articlesIds
							}
						},
						size: limit,
						sort: {
							initialPublishedDate: {
								order: 'desc'
							}
						}
					};
					return es.searchArticles(esQuery);
				}
			})
			.then(articles => {
				if (articles) {
					setCache(res, searchStreamCache);
					articles.hits.total = indexCount;
					res.json(articles);
				} else {
					res.json({
						hits: {
							hits: []
						}
					});
				}
			})
			.catch(console.log);
	}
});

const handleVanityArticle = (req, res, next) => {
	const urlToSearch = `*://ftalphaville.ft.com/${sanitizeParam(req.params[0])}/`;
	return es.getArticleByUrl(urlToSearch)
		.then(article => {
			if (article.found === false) {
				setNoCache(res);
				res.status(404);
			} else if (article.isMarketsLive) {
				if (article.isLive) {
					setNoCache(res);
				} else {
					const today = new Date();
					const publishedDate = new Date(article._source.initialPublishedDate);

					if (publishedDate.getUTCFullYear() === today.getUTCFullYear()
							&& publishedDate.getUTCMonth() === today.getUTCMonth()
							&& publishedDate.getUTCDate() === today.getUTCDate()) {
						// on the day of publishing apply short cache
						setCache(res, mlCacheShort);
					} else {
						setCache(res, mlCacheLong);
					}
				}
			} else {
				setCache(res, articleCache);
			}

			res.json(article);
		})
		.catch(next);
};

const handleUuidArticle = (req, res, next) => {
	return es.getArticleByUuid(req.params[0])
		.then(article => {
			if (article.found === false) {
				setNoCache(res);
				res.status(404);
			} else if (article.isMarketsLive) {
				if (article.isLive) {
					setNoCache(res);
				} else {
					const today = new Date();
					const publishedDate = new Date(article._source.initialPublishedDate);

					if (publishedDate.getUTCFullYear() === today.getUTCFullYear()
							&& publishedDate.getUTCMonth() === today.getUTCMonth()
							&& publishedDate.getUTCDate() === today.getUTCDate()) {
						// on the day of publishing apply short cache
						setCache(res, mlCacheShort);
					} else {
						setCache(res, mlCacheLong);
					}
				}
			} else {
				setCache(res, articleCache);
			}

			res.json(article);
		})
		.catch(next);
};

//article
router.get(vanityRegex, handleVanityArticle);
router.get(uuidRegex, handleUuidArticle);

//author
router.get('/author', (req, res, next) => {
	const authorString = req.query.q || null;
	let esQuery = getEsQueryForArticles(req);
	if (authorString) {
		const authorQuery = {
			query: {
				wildcard : {
					byline: `*${authorString}*`
				}
			}
		};
		esQuery = _.merge(esQuery, authorQuery);
	}
	es.searchArticles(esQuery)
		.then(articles => {
			setCache(res, authorStreamCache);

			res.json(articles);
		})
		.catch(next);
});

//marketslive
router.get('/marketslive', (req, res, next) => {
	const mlQuery = {
		filter: {
			and: {
				filters: [
					{
						term: {
							"metadata.primary": {
								value: "section"
							},
							"metadata.idV1": {
								value: "NzE=-U2VjdGlvbnM=" // Markets
							}
						}
					},
					{
						regexp: {
							webUrl: {
								value: "(.*)marketslive(.*)"
							}
						}
					}
				]
			}
		}
	};
	const esQuery = _.merge(getEsQueryForArticles(req), mlQuery);
	es.searchArticles(esQuery)
		.then(articles => {
			if (articles && articles.hits && articles.hits.hits) {
				let isLive = false;
				articles.hits.hits.forEach(article => {
					if (article.isLive) {
						isLive = true;
					}
				});

				if (!isLive) {
					setCache(res, mlStreamCache);
				} else {
					setNoCache(res);
				}

				res.json(articles);
			} else {
				res.json({
					hits: {
						hits: []
					}
				});
			}
		})
		.catch(next);
});

router.get(mlVanityRegex, handleVanityArticle);
router.get(mlUuidRegex, handleUuidArticle);

router.get('/hotarticles', (req, res, next) => {
	let limit = 30;
	if (req.query.limit) {
		limit = parseInt(req.query.limit, 10);

		if (limit > 90) {
			limit = 90;
		}
	}

	return suds.getHotArticles({
		tag: [
			'brand.FT_Alphaville',
			'brand.First_FT'
		],
		op: 'or',
		number: limit + 10
	}).then(results => {
		setCache(res, hotStreamCache);

		const articles = results
			.filter(a => a.url.indexOf('marketslive') === -1);

		const articleIds = articles.map(a => a.articleId);

		return es.searchArticles({
			query: {
				ids: {
					values: articleIds
				}
			},
			size: limit
		}).then(articles => {
			if (articles && articles.hits && articles.hits.hits) {
				const sortedResult = [];
				articles.hits.hits.forEach((article) => {
					if (articleIds.indexOf(article._id) >= 0) {
						sortedResult[articleIds.indexOf(article._id)] = article;
					}
				});

				articles.hits.hits = sortedResult.filter(a => a !== null);

				res.json(articles);
			} else {
				res.json({
					hits: {
						hits: []
					}
				});
			}
		});
	}).catch(next);
});

router.get('/most-read', (req, res, next) => {
	let limit = 30;
	if (req.query.limit) {
		limit = parseInt(req.query.limit, 10);
	}

	setCache(res, hotStreamCache);

	popularArticlesPoller.get(limit).then(obj => {

		const transformPromises = [];
		const articles = {hits:{hits:[]}};

		obj.forEach((article) => {
			const urlToSearch = `*://ftalphaville.ft.com/${sanitizeParam(article.pathname)}/`;
			articles.hits.hits.push({url:urlToSearch, count:article.count});
		});

		articles.hits.hits.forEach((article, index, source) => {
			transformPromises.push(Promise.all([
					es.getArticleByUrl(article.url).then(response => {
						response.count = article.count;
						source[index] = response;
					})
				]))
		})

		return Promise.all(transformPromises).then(() => {
			res.json(articles);
		});

	}).catch(next);
});

router.get('/most-commented', (req, res, next) => {
	let limit = 30;
	if (req.query.limit) {
		limit = parseInt(req.query.limit, 10);
	}

	setCache(res, hotStreamCache);

	mostCommentedArticlesPoller.get(limit).then(obj => {
		const transformPromises = [];
		const articles = {hits:{hits:[]}};

		obj.forEach((article) => {
			const urlToSearch = `*://ftalphaville.ft.com/${sanitizeParam(article.pathname)}/`;
			articles.hits.hits.push({url:urlToSearch, count:article.count});
		});

		articles.hits.hits.forEach((article, index, source) => {
			transformPromises.push(Promise.all([
					es.getArticleByUrl(article.url).then(response => {
						response.count = article.count;
						source[index] = response;
					})
				]))
		})

		return Promise.all(transformPromises).then(() => {
			res.json(articles);
		});

	}).catch(next);
});

router.get('/popular-topic', (req, res, next) => {
	let limit = 5;
	if (req.query.limit) {
		limit = parseInt(req.query.limit, 10);
	}

	setCache(res, hotStreamCache);

	mostPopularTopicPoller.get(limit).then(results => {
		res.json(results);
	});

});

router.get('/type', (req, res, next) => {
	const type = req.query.type;
	let esQuery = getEsQueryForArticles(req);

	if (type === 'Guest post'){
		esQuery = _.merge(esQuery, {
			filter: {
				and : {
					filters : [
						{
							regexp: {
								webUrl: {
									value: "(.*)guest-post(.*)"
								}
							}
						},{
							regexp: {
								byline: {
									value: "(.*)Guest writer(.*)"
								}
							}
						}
					]
				}
			}
		});
	} else if (type === 'FT Opening Quote'){
		esQuery = _.merge(esQuery, {
			filter: {
				and : {
					filters : [
						{
							regexp: {
								webUrl: {
									value: "(.*)opening-quote(.*)"
								}
							}
						}
					]
				}
			}
		});
	} else {
		esQuery = _.merge(esQuery, {
			filter : {
				regexp: {
					webUrl: {
						value: `(.*)${type.toLowerCase().replace(' ', '-')}(.*)`
					}
				}
			}
		});

	}

	es.searchArticles(esQuery)
		.then(articles => {
			setCache(res, searchStreamCache);
			res.json(articles);
		})
		.catch(next);
});


router.get('/series', (req, res, next) => {
	const series = req.query.series;
	let esQuery = getEsQueryForArticles(req);
	const seriesQuery = {
		filter: {
			term: {
				"annotations.directType": {
					value: "http://www.ft.com/ontology/AlphavilleSeries"
				},
				"annotations.prefLabel": {
					value : series
				}
			}
		}
	};
	esQuery = _.merge(esQuery, seriesQuery);
	es.searchArticles(esQuery)
		.then(articles => {
			setCache(res, searchStreamCache);
			res.json(articles);
		})
		.catch(next);
});


router.get('/topic', (req, res, next) => {
	const topic = req.query.topic;
	let esQuery = getEsQueryForArticles(req);
	const topicQuery = {
		filter: {
			term: {
				"annotations.directType": {
					value: "http://www.ft.com/ontology/Topic"
				},
				"annotations.prefLabel": {
					value : topic
				}
			}
		}
	};
	esQuery = _.merge(esQuery, topicQuery);
	es.searchArticles(esQuery)
		.then(articles => {
			setCache(res, searchStreamCache);
			res.json(articles);
		})
		.catch(next);
});



router.post('/purge', (req, res, next) => {
	const url = req.body.url;
	if (url) {
		return fastly.purge(url).then(obj => {
			res.json(obj);
		}).catch(next);
	}
	return next('No path to purge provided');
});


module.exports = router;