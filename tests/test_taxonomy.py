import unittest

from sync import taxonomy


class HaystackTest(unittest.TestCase):
    def test_joins_path_segments_and_title_casefolded(self) -> None:
        haystack = taxonomy.build_haystack("云栖大会/2026/Qoder.PPTX", "Qoder 方案")

        self.assertEqual(haystack, " 云栖大会 2026 qoder.pptx qoder 方案 ")

    def test_ignores_empty_path_segments(self) -> None:
        self.assertEqual(taxonomy.build_haystack("//资料///"), " 资料  ")

    def test_blank_title_leaves_a_separator_so_tokens_still_end_cleanly(self) -> None:
        self.assertTrue(taxonomy.matches(taxonomy.FacetRule("Qoder", tokens=("qoder",)), taxonomy.build_haystack("Qoder/")))


class MatchesTest(unittest.TestCase):
    def test_terms_match_as_substrings(self) -> None:
        rule = taxonomy.FacetRule("大数据与数据智能", terms=("数据中台",))

        self.assertTrue(taxonomy.matches(rule, taxonomy.build_haystack("资料/集团数据中台规划.docx")))

    def test_tokens_respect_ascii_boundaries(self) -> None:
        rule = taxonomy.FacetRule("Qoder", tokens=("qoder",))

        self.assertTrue(taxonomy.matches(rule, taxonomy.build_haystack("Qoder/方案.pptx")))
        self.assertTrue(taxonomy.matches(rule, taxonomy.build_haystack("资料/Qoder方案.pptx")))
        self.assertFalse(taxonomy.matches(rule, taxonomy.build_haystack("QoderWork/手册.pptx")))

    def test_patterns_support_lookahead(self) -> None:
        rule = taxonomy.FacetRule("智慧家", patterns=(r"智慧家(?!庭)",))

        self.assertTrue(taxonomy.matches(rule, taxonomy.build_haystack("智慧家门店方案.pptx")))
        self.assertFalse(taxonomy.matches(rule, taxonomy.build_haystack("海尔智慧家庭方案.pptx")))

    def test_unrelated_rule_does_not_match(self) -> None:
        rule = taxonomy.FacetRule("具身智能", terms=("具身", "机器人"))

        self.assertFalse(taxonomy.matches(rule, taxonomy.build_haystack("Qoder/方案.pptx")))


class ClassifyTest(unittest.TestCase):
    def test_returns_three_orthogonal_facets(self) -> None:
        result = taxonomy.classify("云栖大会/海信/Qoder方案.pptx", "海信码力大赛复盘")

        self.assertEqual(set(result), {"solutionTracks", "customers", "events"})
        self.assertEqual(result["solutionTracks"], ["Qoder", "AI Coding 与 Harness"])
        self.assertEqual(result["customers"], ["海信"])
        self.assertEqual(result["events"], ["云栖大会", "海信码力大赛"])

    def test_unmatched_path_yields_empty_facets(self) -> None:
        result = taxonomy.classify("随手记/临时草稿.md")

        self.assertEqual(
            result,
            {"solutionTracks": [], "customers": [], "events": []},
        )

    def test_each_facet_is_capped(self) -> None:
        result = taxonomy.classify("大数据 数据中台 安全 合规 知识库 培训.pptx")

        self.assertEqual(len(result["solutionTracks"]), taxonomy.MAX_TRACKS)
        self.assertEqual(
            result["solutionTracks"],
            ["大数据与数据智能", "安全与合规", "知识管理与 RAG"],
        )

    def test_infer_facet_preserves_rule_order(self) -> None:
        rules = (
            taxonomy.FacetRule("乙"),
            taxonomy.FacetRule("甲", terms=("资料",)),
            taxonomy.FacetRule("丙", terms=("资料",)),
        )

        self.assertEqual(taxonomy.infer_facet(rules, " 资料 ", limit=2), ["甲", "丙"])


class FacetLabelsTest(unittest.TestCase):
    def test_falls_back_when_facet_is_absent(self) -> None:
        self.assertEqual(
            taxonomy.facet_labels({}, "customers", taxonomy.UNCLASSIFIED_CUSTOMER),
            [taxonomy.UNCLASSIFIED_CUSTOMER],
        )

    def test_falls_back_when_every_value_is_blank(self) -> None:
        self.assertEqual(
            taxonomy.facet_labels({"customers": ["", "   "]}, "customers", taxonomy.UNCLASSIFIED_CUSTOMER),
            [taxonomy.UNCLASSIFIED_CUSTOMER],
        )

    def test_drops_blank_values_and_keeps_the_rest(self) -> None:
        self.assertEqual(
            taxonomy.facet_labels({"customers": ["  ", "海信", "海尔"]}, "customers", taxonomy.UNCLASSIFIED_CUSTOMER),
            ["海信", "海尔"],
        )


class FacetRowsTest(unittest.TestCase):
    def test_sorts_by_count_then_name_and_keeps_the_fallback_bucket(self) -> None:
        documents = [
            {"customers": []},
            {"customers": ["海信", "海尔"]},
            {"customers": ["海信"]},
            {"customers": ["B客户"]},
            {"customers": ["A客户"]},
        ]

        self.assertEqual(
            taxonomy.facet_rows(documents, "customers", taxonomy.UNCLASSIFIED_CUSTOMER),
            [
                {"name": "海信", "count": 2},
                {"name": "A客户", "count": 1},
                {"name": "B客户", "count": 1},
                {"name": taxonomy.UNCLASSIFIED_CUSTOMER, "count": 1},
                {"name": "海尔", "count": 1},
            ],
        )

    def test_omits_the_fallback_bucket_when_every_document_is_labelled(self) -> None:
        rows = taxonomy.facet_rows(
            [{"events": ["云栖大会"]}, {"events": ["云栖大会"]}],
            "events",
            taxonomy.NO_EVENT,
        )

        self.assertEqual(rows, [{"name": "云栖大会", "count": 2}])

    def test_empty_inventory_produces_no_rows(self) -> None:
        self.assertEqual(taxonomy.facet_rows([], "customers", taxonomy.UNCLASSIFIED_CUSTOMER), [])

    def test_all_facet_rows_covers_every_facet(self) -> None:
        result = taxonomy.all_facet_rows([{"solutionTracks": ["Qoder"], "customers": [], "events": ["云栖大会"]}])

        self.assertEqual(set(result), {"bySolutionTrack", "byCustomer", "byEvent"})
        self.assertEqual(result["bySolutionTrack"], [{"name": "Qoder", "count": 1}])
        self.assertEqual(result["byCustomer"], [{"name": taxonomy.UNCLASSIFIED_CUSTOMER, "count": 1}])
        self.assertEqual(result["byEvent"], [{"name": "云栖大会", "count": 1}])


class RuleTableTest(unittest.TestCase):
    def test_labels_are_unique_per_facet(self) -> None:
        for rules in (taxonomy.SOLUTION_TRACK_RULES, taxonomy.CUSTOMER_RULES, taxonomy.EVENT_RULES):
            labels = [rule.label for rule in rules]
            self.assertEqual(len(labels), len(set(labels)))

    def test_every_rule_can_match_something(self) -> None:
        for rules in (taxonomy.SOLUTION_TRACK_RULES, taxonomy.CUSTOMER_RULES, taxonomy.EVENT_RULES):
            for rule in rules:
                self.assertTrue(rule.tokens or rule.terms or rule.patterns, rule.label)

    def test_fallbacks_cover_every_facet_key(self) -> None:
        self.assertEqual(
            set(taxonomy.FACET_FALLBACKS),
            {"solutionTracks", "customers", "events"},
        )
        self.assertEqual(
            taxonomy.FACET_FALLBACKS,
            {
                "solutionTracks": taxonomy.UNCLASSIFIED_TRACK,
                "customers": taxonomy.UNCLASSIFIED_CUSTOMER,
                "events": taxonomy.NO_EVENT,
            },
        )


if __name__ == "__main__":
    unittest.main()
