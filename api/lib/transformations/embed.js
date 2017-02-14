"use strict";

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const avSeries = require('./series');
const categorization = require('../utils/categorization');

function embedPodcast (article) {
	const url = `${process.env.PROD_WP_URL}${article._source.av2WebUrl}?json=1&api_key=${process.env['WP_API_KEY']}`;

	return fetch(url)
		.then(res => res.json())
		.then(json => {
			if (json && json.post &&
					json.post.custom_fields &&
					json.post.custom_fields &&
					json.post.custom_fields.embed1 &&
					json.post.custom_fields.embed1.length) {
				const embedCode = json.post.custom_fields.embed1[0].replace(/http\:/g, 'https:');
				article._source.bodyHTML = embedCode + article._source.bodyHTML; 
			}
		})
		.catch((err) => {
			console.log("Error fetching embeds for article " + article._id, err);
		});
}

function embedFtVideo (article) {
	return new Promise((resolve) => {
		let $;
		try {
			$ = cheerio.load(article._source.bodyHTML);

			$('.n-content-video--brightcove').each(function () {
				const el = $(this);
				const href = el.find('a').attr('href');
				const vIdMatch = href.match(/video\.ft\.com\/([0-9]+)/);
				let videoId;
				if (vIdMatch && vIdMatch.length) {
					videoId = vIdMatch[1];
				}

				if (videoId) {
					el.replaceWith($(`<div class="o-video o-video--large" data-o-component="o-video" data-o-video-id="${videoId}" data-o-video-advertising="true" data-o-video-placeholder="true"></div>`));
				}
			});

			article._source.bodyHTML = $.html();
			resolve(article);
		} catch (e) {
			console.log("ERROR", e);
			console.log(article._source.id);

			resolve(article);
			return;
		}
	});
}


exports.processArticle = function (article) {
	return new Promise((resolve) => {
		if (article._source) {
			const embeds = [];
			if (article._source.bodyHTML) {
				if (avSeries.getSeries(article, 'Alphachat') || avSeries.getSeries(article, 'Alphachatterbox') || categorization.isPodcast(article)) {
					embeds.push(embedPodcast(article));
				}

				if (article._source.bodyHTML.indexOf('n-content-video--brightcove') !== -1) {
					embeds.push(embedFtVideo(article));
				}
			}

			Promise.all(embeds).then(() => {
				resolve(article);
			}).catch(() => {
				resolve(article);
			});
		} else {
			resolve(article);
		}
	});
};